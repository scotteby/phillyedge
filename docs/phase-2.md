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
curl https://phillyedge.vercel.app/api/daily-settlement?date=2026-04-29
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

## Phase 2.5 — Recommendation Logging

### Why
The Phase 2 dashboard only sees trades the user actually placed. That's a
selection-biased view: it can't distinguish "the system generated a great
signal" from "the user chose to act on a great signal." Phase 2.5 captures
*every* actionable signal (buy / strong-buy) at render time so we can
quantify the user's selection alpha — the value added by *which* signals
they decide to trade.

### Schema — `recommendation_log`
Migration: `supabase/migrations/20260430_phase25_recommendation_log.sql`.

| column | meaning |
|---|---|
| `generated_at` | when the row was logged (server render time) |
| `target_date` | day the weather will be observed |
| `market_id` / `market_question` | the bracket market |
| `signal` | `'buy'` or `'strong-buy'` — only actionable signals are logged |
| `edge` | bracket edge at render time |
| `bracket_type` | `forecast` / `adjacent_low` / `adjacent_high` / `other` |
| `my_pct` / `market_pct` | our probability and the market's, both 0–100 |
| `side` | `YES` or `NO` — the side our system would recommend |
| `confidence_level` | snapshot of `forecasts.forecast_confidence` |
| `acted_on` | flipped to `true` when a matching trade is placed |
| `trade_id` | back-reference into `trades` |
| `settled` / `would_have_won` / `hypothetical_pnl_at_10` | filled by daily settlement |

### Dedup rule (plain English)
A row is uniquely keyed by `(market_id, target_date, signal, bracket_type)`.
Re-loading the markets page on the same day for the same market with the
same signal is a no-op. But if the signal *upgrades* (e.g. `buy` →
`strong-buy` once edge crosses 25pt), the unique key changes and a brand-new
row is inserted — that's intentional, so the upgrade is preserved.

### Hook points
1. **`app/markets/page.tsx`**: after `groupBracketMarkets()` resolves, we
   call `logActionableSignals(groups, confidenceMap, supabase)` *fire and
   forget* (`void` + `.catch`). Failure is swallowed to a console log so the
   page render and trading flow are untouched.
2. **`app/api/place-trade/route.ts`**: after the successful `trades` insert,
   we capture the inserted `id` and call `linkTradeToRecommendation(id,
   ticker, target_date, supabase)` fire-and-forget. It picks the most-recent
   unacted matching row within a 24-hour window and flips
   `acted_on = true`.

### Settlement
`settleRecommendationLog(date, actuals, supabase)` is called from the daily
settlement route alongside the existing `forecast_results` /
`recommendation_results` upserts. For each unsettled row it:

- builds a minimal Trade-like object from the row,
- runs `didTradeWin` against the actual weather,
- computes `calcHypotheticalPnl(10, market_pct / 100, side, won)`,
- writes back `{ settled, would_have_won, hypothetical_pnl_at_10 }`.

Critically, hypothetical P&L is computed using `market_pct` (the market
probability at recommendation time), **not** `entry_yes_price`. This is
intentional: we want to measure signal quality at the moment the
recommendation appeared, independent of fill price drift or partial fills.

### How to interpret selection alpha
```
placed_avg = mean(hypothetical_pnl_at_10) where acted_on = true
all_avg    = mean(hypothetical_pnl_at_10) over all settled rows
alpha      = placed_avg - all_avg
```
Reading:

- **alpha > +$0.20** → "Your selection is adding value." You are
  systematically picking signals that out-earn the universe of signals.
- **alpha < −$0.20** → "Your selection is hurting performance." You'd do
  better trading every actionable signal you're shown.
- **|alpha| < $0.20** → "Selection is roughly neutral." Your discretion
  doesn't move the needle either way; randomness dominates.

Only shown once both buckets (acted, not-acted) reach n ≥ 20 settled rows.

### Current limitations
- **No backfill possible.** `market_cache` is wiped on each refresh, so we
  can't reconstruct historical bracket signals. Logging starts the day this
  ships.
- **Edge drift within a session is not tracked.** If a Strong Buy
  decays back to Buy mid-day, the existing row stays Strong Buy until
  settlement. Re-renders after the dedup key changes (signal upgrade) do
  insert new rows; downgrades do not.
- **No per-render snapshot.** We capture the *first* time a (market,
  signal, bracket_type) tuple appears each day. We do not track the full
  time-series of edge / market price between render and trade.

