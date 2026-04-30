# Phase 2 — Performance Tracking

A daily settlement job that compares each day's forecasts and recommended trades
to the actual outcome, and a `/performance` dashboard that surfaces accuracy,
P&L, and calibration metrics over time.

## 1. Schema

Two new tables, both append-only with idempotency constraints. See the
migration at `supabase/migrations/20260430_phase2_performance.sql`.

### `forecast_results`
| column | meaning |
|---|---|
| `forecast_id` | FK → `forecasts.id` |
| `forecast_date` | the day the weather was observed (= `forecasts.target_date`) |
| `metric` | `'high'` \| `'low'` \| `'precip'` |
| `predicted_value` | high/low: °F. precip: predicted % chance (0–100). |
| `actual_value` | high/low: °F. precip: `100` if it rained, `0` if it didn't. |
| `error` | generated: `predicted - actual` |
| `abs_error` | generated: `|predicted - actual|` |
| `confidence_level` | snapshot of `forecasts.forecast_confidence` at settlement time |

Encoding the precip outcome as 100/0 in the same `actual_value` column makes
`error` directly interpretable as a percentage-point probability error
(e.g. forecast 30%, didn't rain → error = 30).

Unique constraint on `(forecast_date, metric)` — the daily settlement job
upserts and is safe to call multiple times.

### `recommendation_results`
| column | meaning |
|---|---|
| `trade_id` | FK → `trades.id` (unique) |
| `bracket_type` | where our forecast (trade.my_pct) sits relative to this bracket |
| `recommended_size` | the `amount_usdc` we placed |
| `actually_placed` | always `true` for now (we only track real trades) |
| `would_have_won` | computed from market_id + range vs `ActualWeather` |
| `hypothetical_pnl` | what this trade would have made/lost at the placed size |
| `normalized_pnl_at_10` | the same trade rerun at $10 — comparable across signals |
| `actual_pnl` | mirrored from `trades.pnl`, null until trade settles |

## 2. Daily Settlement

Source: `app/api/daily-settlement/route.ts`, calling pure logic in
`lib/settlement.ts`.

Algorithm:
1. Determine the settlement date (yesterday in ET if not given).
2. Fetch actual weather from NWS KPHL (`fetchActualWeather`).
3. Look up the most recent `forecasts` row for that `target_date`.
4. Build & upsert three `forecast_results` rows.
5. Pull all `trades` for that `target_date` whose outcome is `win` or `loss`.
6. Build & upsert one `recommendation_results` row per trade.

Manual trigger:

```bash
curl -X POST https://your-app.vercel.app/api/daily-settlement \
  -H 'Content-Type: application/json' \
  -d '{"date":"2026-04-29"}'
```

Or hit the GET form (also accepts `?date=YYYY-MM-DD`):

```bash
curl https://your-app.vercel.app/api/daily-settlement?date=2026-04-29
```

Response shape:

```json
{
  "settled_date": "2026-04-29",
  "forecast_rows": 3,
  "recommendation_rows": 5,
  "skipped": [],
  "errors": []
}
```

## 3. Cron

`vercel.json`:

```json
{
  "crons": [
    { "path": "/api/daily-settlement", "schedule": "0 15 * * *" }
  ]
}
```

15:00 UTC = 10 AM ET (winter) / 11 AM ET (summer) — well after midnight, so
both temperature extremes from the previous ET day are available. Vercel cron
issues a `GET`, which the route handler accepts.

To verify it ran: check the Vercel project's "Crons" tab, or query
`forecast_results.created_at` for the most recent insertion.

## 4. Backfill

For historical days where settlement was never run:

```bash
npx tsx scripts/backfill-settlements.ts --start=2026-01-01 --end=2026-04-29
```

The script loops day-by-day, calls the same logic, and prints a summary at the
end. Days with no forecast row and no settled trades are logged as `skipped`.
The upsert constraints make it safe to re-run.

## 5. Dashboard

URL: `/performance`

Sections (all visible — no tabs, anchored navigation):

1. **Observations** — 3–5 factual bullets generated from settled history (only
   shown once n ≥ 10 per group).
2. **Forecast Accuracy** — daily-results table, MAE summary cards (7-day &
   30-day for high/low), rolling 30-day MAE chart, weekly bias bar chart, top
   10 highest-error days.
3. **Recommendation Performance** — cumulative actual vs hypothetical P&L,
   win-rate cards (overall / strong-buy / buy), segment breakdown by signal,
   edge bucket, and bracket type.
4. **Calibration** — precip calibration curve with bin sample sizes, plus
   per-confidence-level temperature std-dev table flagging any level that
   deviates from its stated value by >20%.

## 6. Tests

`lib/settlement.test.ts` — pure-logic tests for P&L math, win detection across
all market types, range parsing, calibration bin assignment, and insight
gating. Run with:

```bash
npx tsx --test lib/settlement.test.ts
```
