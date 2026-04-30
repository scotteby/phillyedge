/**
 * Phase 2: Daily-settlement pure logic.
 *
 * No DB writes here — the API route is responsible for persistence.
 * The only network call is the NWS observation fetch.
 *
 * Precip encoding (matches forecast_results table):
 *   predicted_value = forecast.precip_chance   (0–100)
 *   actual_value    = 100 if it rained, 0 if it didn't
 *   so error is interpretable as a percentage-point probability error.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Forecast, ForecastConfidence, Trade } from "./types";

// ── Public types ──────────────────────────────────────────────────────────────

export interface ActualWeather {
  date:        string;   // YYYY-MM-DD (ET calendar day)
  actualHigh:  number;   // °F
  actualLow:   number;   // °F
  rained:      boolean;  // any non-zero precipitationLastHour observation
}

export type ForecastMetric = "high" | "low" | "precip";

export interface ForecastResultRow {
  forecast_id:      string;
  forecast_date:    string;       // = target_date of forecast
  metric:           ForecastMetric;
  predicted_value:  number;
  actual_value:     number;
  confidence_level: ForecastConfidence;
}

export type BracketType = "forecast" | "adjacent_low" | "adjacent_high" | "other";

export interface RecommendationResultRow {
  trade_id:              string;
  market_id:             string;
  forecast_date:         string;
  signal:                string;
  edge:                  number;
  bracket_type:          BracketType;
  recommended_size:      number;
  actually_placed:       boolean;
  actual_size:           number | null;
  placed_at:             string | null;
  would_have_won:        boolean;
  hypothetical_pnl:      number;
  normalized_pnl_at_10:  number;
  actual_pnl:            number | null;
}

export interface SettlementSummary {
  settled_date:        string;
  forecast_rows:       number;
  recommendation_rows: number;
  rec_log_rows:        number;
  skipped:             string[];
  errors:              string[];
}

// ── NWS fetch ─────────────────────────────────────────────────────────────────

function cToF(celsius: number | null | undefined): number | null {
  if (celsius == null) return null;
  return Math.round(celsius * 9 / 5 + 32);
}

/**
 * Add `days` to a YYYY-MM-DD date string (UTC-safe — operates on calendar parts).
 */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Fetch yesterday's actual weather from NWS KPHL station for a given ET calendar day.
 *
 * The NWS API returns observations in UTC.  Eastern midnight is 05:00 UTC (EST)
 * or 04:00 UTC (EDT) — using 05:00Z for both bounds is safe in EST and gives a
 * 1-hour DST overlap in EDT (still better than missing observations).
 */
/**
 * Fetch actual weather for a given date.
 * - Recent data (≤7 days ago): NWS KPHL hourly observations
 * - Historical data (>7 days ago): Open-Meteo archive API
 *   (free, no API key, Philadelphia Airport coords 39.8729°N 75.2408°W)
 */
export async function fetchActualWeather(date: string): Promise<ActualWeather> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - 7);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  return date >= cutoffStr
    ? fetchActualWeatherNWS(date)
    : fetchActualWeatherOpenMeteo(date);
}

async function fetchActualWeatherNWS(date: string): Promise<ActualWeather> {
  const start = `${date}T05:00:00Z`;
  const end   = `${addDays(date, 1)}T05:00:00Z`;
  const url   = `https://api.weather.gov/stations/KPHL/observations?start=${start}&end=${end}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "PhillyEdge/1.0 (scott.m.eby@gmail.com)",
      Accept:       "application/geo+json",
    },
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`NWS observations fetch failed for ${date}: ${res.status}`);
  }

  const json     = await res.json();
  const features = (json.features ?? []) as Array<{ properties: Record<string, unknown> }>;

  let max: number | null = null;
  let min: number | null = null;
  let rained = false;

  for (const f of features) {
    const p     = f.properties;
    const tempC = (p.temperature as { value?: number | null } | null)?.value;
    const tempF = cToF(tempC);
    if (tempF !== null) {
      if (max === null || tempF > max) max = tempF;
      if (min === null || tempF < min) min = tempF;
    }
    const precip =
      (p.precipitationLastHour as { value?: number | null } | null)?.value ??
      (p.precipitationLast3Hours as { value?: number | null } | null)?.value ??
      null;
    if (precip != null && precip > 0) rained = true;
  }

  if (max === null || min === null) {
    throw new Error(`No valid temperature readings from NWS for ${date}`);
  }

  return { date, actualHigh: max, actualLow: min, rained };
}

async function fetchActualWeatherOpenMeteo(date: string): Promise<ActualWeather> {
  // Open-Meteo archive: daily summary for Philadelphia Airport (KPHL) coordinates
  const url = [
    "https://archive-api.open-meteo.com/v1/archive",
    `?latitude=39.8729&longitude=-75.2408`,
    `&start_date=${date}&end_date=${date}`,
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum`,
    `&temperature_unit=fahrenheit`,
    `&precipitation_unit=inch`,
    `&timezone=America%2FNew_York`,
  ].join("");

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Open-Meteo fetch failed for ${date}: ${res.status}`);
  }

  const json  = await res.json() as {
    daily?: {
      temperature_2m_max:  (number | null)[];
      temperature_2m_min:  (number | null)[];
      precipitation_sum:   (number | null)[];
    };
  };

  const high   = json.daily?.temperature_2m_max?.[0]  ?? null;
  const low    = json.daily?.temperature_2m_min?.[0]   ?? null;
  const precip = json.daily?.precipitation_sum?.[0]    ?? null;

  if (high === null || low === null) {
    throw new Error(`No temperature data from Open-Meteo for ${date}`);
  }

  return {
    date,
    actualHigh: Math.round(high),
    actualLow:  Math.round(low),
    rained:     precip != null && precip > 0,
  };
}

// ── Forecast result rows ──────────────────────────────────────────────────────

export function buildForecastResultRows(
  forecast: Forecast,
  actuals: ActualWeather,
): ForecastResultRow[] {
  const confidence: ForecastConfidence = forecast.forecast_confidence ?? "confident";
  const date = actuals.date;

  return [
    {
      forecast_id:      forecast.id,
      forecast_date:    date,
      metric:           "high",
      predicted_value:  forecast.high_temp,
      actual_value:     actuals.actualHigh,
      confidence_level: confidence,
    },
    {
      forecast_id:      forecast.id,
      forecast_date:    date,
      metric:           "low",
      predicted_value:  forecast.low_temp,
      actual_value:     actuals.actualLow,
      confidence_level: confidence,
    },
    {
      forecast_id:      forecast.id,
      forecast_date:    date,
      metric:           "precip",
      predicted_value:  forecast.precip_chance,
      actual_value:     actuals.rained ? 100 : 0,
      confidence_level: confidence,
    },
  ];
}

// ── Bracket parsing ───────────────────────────────────────────────────────────
// Subset of lib/brackets.ts logic — duplicated here on purpose so settlement
// has no coupling to the live-trading bracket builder.

export interface ParsedRange {
  min: number | null;  // inclusive lower bound, null = -∞
  max: number | null;  // inclusive upper bound, null = +∞
  isPrecip: boolean;
}

export function parseRangeFromQuestion(question: string): ParsedRange {
  const t = question.toLowerCase();

  // Precip markets — no temperature range
  if (t.includes("rain") || t.includes("precip") || t.includes("snow")) {
    return { min: null, max: null, isPrecip: true };
  }

  // ">67°F" / "above 67"
  const above =
    t.match(/(?:at\s+or\s+)?above\s+(\d+)/i) ||
    t.match(/[>≥]=?\s*(\d+)/);
  if (above) return { min: parseInt(above[1]), max: null, isPrecip: false };

  // "<65°F" / "below 65"
  const below =
    t.match(/(?:at\s+or\s+)?below\s+(\d+)/i) ||
    t.match(/[<≤]=?\s*(\d+)/);
  if (below) return { min: null, max: parseInt(below[1]), isPrecip: false };

  // "65–67°F" / "65-67" / "between 65 and 67"
  const between =
    t.match(/between\s+(\d+)[°\s].*?and\s+(\d+)/i) ||
    t.match(/(\d+)°?\s*(?:to|–|-)\s*(\d+)°?/);
  if (between) return { min: parseInt(between[1]), max: parseInt(between[2]), isPrecip: false };

  return { min: null, max: null, isPrecip: false };
}

/**
 * Does `value` fall inside `range`?
 *
 * Convention matches lib/brackets.ts inRange:
 *   - between:  inclusive on both ends (e.g. 65–67° includes 65 and 67)
 *   - <X:       exclusive (X belongs to next bracket up)
 *   - >X:       exclusive (X belongs to next bracket down)
 */
export function valueInRange(value: number, range: ParsedRange): boolean {
  if (range.min === null && range.max === null) return false;
  if (range.min === null) return value < (range.max as number);
  if (range.max === null) return value > range.min;
  return value >= range.min && value <= range.max;
}

// ── Market type detection ────────────────────────────────────────────────────

export type MarketKind = "high" | "low" | "precip" | "unknown";

export function classifyMarket(marketId: string): MarketKind {
  const head = marketId.toUpperCase().split("-")[0];
  if (head === "KXHIGHPHIL")    return "high";
  if (head === "KXLOWTPHIL")    return "low";
  if (head === "KXPRECIPPHIL")  return "precip";
  return "unknown";
}

// ── Trade outcome resolution ─────────────────────────────────────────────────

export function didTradeWin(trade: Trade, actuals: ActualWeather): boolean {
  const kind = classifyMarket(trade.market_id);
  const range = parseRangeFromQuestion(trade.market_question);

  let inBracket: boolean;
  if (kind === "high")        inBracket = valueInRange(actuals.actualHigh, range);
  else if (kind === "low")    inBracket = valueInRange(actuals.actualLow,  range);
  else if (kind === "precip") inBracket = actuals.rained;
  else                        inBracket = false;

  // YES: bet that the bracket is the outcome.   NO: bet against it.
  return trade.side === "YES" ? inBracket : !inBracket;
}

// ── P&L ──────────────────────────────────────────────────────────────────────

/**
 * Hypothetical P&L if `amount` had been deployed at `entryYesPrice`.
 *
 *   side_price = side === YES ? entryYesPrice : 1 - entryYesPrice
 *   contracts  = floor(amount / side_price)
 *   win        →  contracts * (1 - side_price)
 *   loss       → -(contracts * side_price)
 *
 * Returns 0 if entryYesPrice is non-positive or yields zero contracts.
 */
export function calcHypotheticalPnl(
  amount: number,
  entryYesPrice: number,
  side: "YES" | "NO",
  won: boolean,
): number {
  if (entryYesPrice <= 0 || entryYesPrice >= 1) return 0;
  const sidePrice = side === "YES" ? entryYesPrice : 1 - entryYesPrice;
  if (sidePrice <= 0) return 0;
  const contracts = Math.floor(amount / sidePrice);
  if (contracts <= 0) return 0;
  return won
    ? parseFloat((contracts * (1 - sidePrice)).toFixed(2))
    : parseFloat((-(contracts * sidePrice)).toFixed(2));
}

// ── Bracket-type derivation ──────────────────────────────────────────────────

/**
 * Where does our forecast (trade.my_pct, used loosely as the recommendation
 * center) fall relative to this trade's bracket?
 *
 * NB: trade.my_pct is in *percentage* units when stored — for bracket trades
 * it's the bracket probability we computed at trade time.  We instead need
 * the *predicted value* (temp °F or precip chance).  Without access to the
 * forecast row from inside this function we make a best-effort derivation:
 *   - If the bracket contains the actual outcome we use a different signal,
 *     so we instead key off the YES/NO side and the bracket relation to the
 *     bracket itself.
 *
 * Because Phase 2 spec says "use trade.my_pct as the 'our forecast' center
 * point", we interpret my_pct in °F directly when the market is high/low.
 * This is a simplification — a future migration could store the forecast
 * temp on the trade row.
 */
export function deriveBracketType(trade: Trade): BracketType {
  const range = parseRangeFromQuestion(trade.market_question);
  const kind  = classifyMarket(trade.market_id);

  if (kind === "precip" || kind === "unknown") return "other";
  if (range.min === null && range.max === null) return "other";

  const center = trade.my_pct;  // interpreted as °F per spec
  if (valueInRange(center, range)) return "forecast";
  if (range.min !== null && center < range.min) return "adjacent_low";
  if (range.max !== null && center > range.max) return "adjacent_high";
  return "other";
}

// ── Recommendation result row ────────────────────────────────────────────────

/**
 * Build one recommendation_results row for a settled trade.
 *
 * Uses entry_yes_price when available.  Falls back to a derivation from
 * market_pct (which was the integer YES price at trade time) so historic
 * trades pre-dating the entry_yes_price column still settle correctly.
 */
export function buildRecommendationResultRow(
  trade: Trade,
  actuals: ActualWeather,
): RecommendationResultRow {
  const won           = didTradeWin(trade, actuals);
  const entryYesPrice = trade.entry_yes_price ?? trade.market_pct / 100;

  const hypotheticalPnl    = calcHypotheticalPnl(trade.amount_usdc, entryYesPrice, trade.side, won);
  const normalizedPnlAt10  = calcHypotheticalPnl(10,                entryYesPrice, trade.side, won);

  return {
    trade_id:              trade.id,
    market_id:             trade.market_id,
    forecast_date:         actuals.date,
    signal:                trade.signal,
    edge:                  trade.edge,
    bracket_type:          deriveBracketType(trade),
    recommended_size:      trade.amount_usdc,
    actually_placed:       true,
    actual_size:           trade.amount_usdc,
    placed_at:             trade.created_at,
    would_have_won:        won,
    hypothetical_pnl:      hypotheticalPnl,
    normalized_pnl_at_10:  normalizedPnlAt10,
    actual_pnl:            trade.pnl,
  };
}

// ── Insights ─────────────────────────────────────────────────────────────────

export interface Insight {
  text:            string;
  n:               number;
  deviationScore:  number;  // higher = more notable
}

const MIN_INSIGHT_N = 10;

function safeMean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/**
 * Generate factual observations from settlement history.  Returns insights
 * with n >= MIN_INSIGHT_N.  Caller can sort by deviationScore.
 *
 * Tone: factual / neutral.  No prescriptive recommendations.
 */
export function generateInsights(
  forecastResults: ForecastResultRow[],
  recResults:      RecommendationResultRow[],
): Insight[] {
  const insights: Insight[] = [];

  // ── Forecast bias by metric ────────────────────────────────────────────────
  for (const metric of ["high", "low", "precip"] as const) {
    const rows = forecastResults.filter((r) => r.metric === metric);
    if (rows.length < MIN_INSIGHT_N) continue;
    const errs = rows.map((r) => Number(r.predicted_value) - Number(r.actual_value));
    const meanErr = safeMean(errs);
    const absMean = Math.abs(meanErr);
    if (metric === "precip") {
      // Only flag a non-trivial precip bias (>5 pp)
      if (absMean > 5) {
        const dir = meanErr > 0 ? "above" : "below";
        insights.push({
          text: `Precip forecasts have averaged ${absMean.toFixed(1)} pp ${dir} actuals over ${rows.length} days.`,
          n: rows.length,
          deviationScore: absMean,
        });
      }
    } else {
      if (absMean > 0.5) {
        const dir = meanErr > 0 ? "above" : "below";
        insights.push({
          text: `${metric === "high" ? "High" : "Low"}-temperature forecasts have averaged ${absMean.toFixed(1)}°F ${dir} actuals over ${rows.length} days.`,
          n: rows.length,
          deviationScore: absMean,
        });
      }
    }
  }

  // ── Win rate by signal ─────────────────────────────────────────────────────
  for (const signal of ["strong-buy", "buy"] as const) {
    const rows = recResults.filter((r) => r.signal === signal);
    if (rows.length < MIN_INSIGHT_N) continue;
    const wins = rows.filter((r) => r.would_have_won).length;
    const rate = wins / rows.length;
    insights.push({
      text: `${signal === "strong-buy" ? "Strong-buy" : "Buy"} signals have won ${Math.round(rate * 100)}% of the time (${wins}/${rows.length}).`,
      n: rows.length,
      deviationScore: Math.abs(rate - 0.5) * 100,
    });
  }

  // ── Win rate by bracket type ───────────────────────────────────────────────
  for (const bt of ["forecast", "adjacent_low", "adjacent_high"] as const) {
    const rows = recResults.filter((r) => r.bracket_type === bt);
    if (rows.length < MIN_INSIGHT_N) continue;
    const wins = rows.filter((r) => r.would_have_won).length;
    const rate = wins / rows.length;
    const label = bt === "forecast" ? "Forecast bracket"
      : bt === "adjacent_low" ? "Adjacent-low bracket" : "Adjacent-high bracket";
    insights.push({
      text: `${label} trades have won ${Math.round(rate * 100)}% of the time (${wins}/${rows.length}).`,
      n: rows.length,
      deviationScore: Math.abs(rate - 0.5) * 100,
    });
  }

  // ── Average normalized P&L per signal ─────────────────────────────────────
  if (recResults.length >= MIN_INSIGHT_N) {
    const avg = safeMean(recResults.map((r) => Number(r.normalized_pnl_at_10)));
    const sign = avg >= 0 ? "+" : "";
    insights.push({
      text: `Average normalized P&L (per $10 signal) is ${sign}$${avg.toFixed(2)} across ${recResults.length} settled trades.`,
      n: recResults.length,
      deviationScore: Math.abs(avg),
    });
  }

  return insights;
}

// ── Calibration helpers (used by both insights and the dashboard) ────────────

export const CALIBRATION_BINS: Array<{ lo: number; hi: number; label: string }> = [
  { lo:  0, hi:  10, label: "0–10%"   },
  { lo: 10, hi:  25, label: "10–25%"  },
  { lo: 25, hi:  50, label: "25–50%"  },
  { lo: 50, hi:  75, label: "50–75%"  },
  { lo: 75, hi:  90, label: "75–90%"  },
  { lo: 90, hi: 100, label: "90–100%" },
];

/**
 * Map a 0–100 probability to a calibration bin index.
 * Boundary rule: the value belongs to the bin whose [lo, hi) it falls in,
 * EXCEPT 100, which goes in the last bin.
 */
export function calibrationBin(p: number): number {
  if (p >= 100) return CALIBRATION_BINS.length - 1;
  if (p < 0)    return 0;
  for (let i = 0; i < CALIBRATION_BINS.length; i++) {
    const { lo, hi } = CALIBRATION_BINS[i];
    if (p >= lo && p < hi) return i;
  }
  return CALIBRATION_BINS.length - 1;
}

// ── Confidence-level std-dev calibration ─────────────────────────────────────

export const STATED_STD_BY_CONFIDENCE: Record<ForecastConfidence, number> = {
  very_confident: 1.5,
  confident:      2.0,
  uncertain:      4.0,
};

export function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = safeMean(xs);
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

// ── Phase 2.5: recommendation_log settlement ─────────────────────────────────

interface RecLogRowDB {
  id:           string;
  market_id:    string;
  market_question: string;
  target_date:  string;
  side:         "YES" | "NO";
  market_pct:   number | string;
}

/**
 * Settle all unsettled recommendation_log rows for a given date.
 *
 * Uses market_pct (the market probability at recommendation time) —
 * NOT entry_yes_price — to compute hypothetical P&L. This is intentional:
 * we want to measure signal quality at the moment it appeared, not the
 * fill price (which may differ due to market movement or partial fills).
 *
 * Idempotent: only processes rows where settled = false.
 */
export async function settleRecommendationLog(
  date:     string,
  actuals:  ActualWeather,
  supabase: SupabaseClient,
): Promise<{ settled: number; errors: string[] }> {
  const errors: string[] = [];

  const { data, error: selErr } = await supabase
    .from("recommendation_log")
    .select("id, market_id, market_question, target_date, side, market_pct")
    .eq("target_date", date)
    .eq("settled", false);

  if (selErr) {
    errors.push(`select: ${selErr.message}`);
    return { settled: 0, errors };
  }

  const rows = (data as RecLogRowDB[] | null) ?? [];
  let settled = 0;

  for (const row of rows) {
    try {
      const marketPct = typeof row.market_pct === "number"
        ? row.market_pct
        : parseFloat(row.market_pct);
      const entryYesPrice = marketPct / 100;

      // Build a minimal Trade-like object — didTradeWin only reads
      // market_id, market_question, side from the trade.
      const tradeLike: Trade = {
        id:               row.id,
        created_at:       "",
        market_id:        row.market_id,
        market_question:  row.market_question,
        target_date:      row.target_date,
        side:             row.side,
        amount_usdc:      0,
        market_pct:       marketPct,
        my_pct:           0,
        edge:             0,
        signal:           "buy",
        outcome:          "pending",
        pnl:              null,
        polymarket_url:   null,
        kalshi_order_id:  null,
        order_status:     null,
        filled_count:     null,
        remaining_count:  null,
        last_checked_at:  null,
        entry_yes_price:  null,
      };

      const won = didTradeWin(tradeLike, actuals);
      const hypoPnl = calcHypotheticalPnl(10, entryYesPrice, row.side, won);

      const { error: updErr } = await supabase
        .from("recommendation_log")
        .update({
          settled:                true,
          would_have_won:         won,
          hypothetical_pnl_at_10: hypoPnl,
        })
        .eq("id", row.id);

      if (updErr) {
        errors.push(`update ${row.id}: ${updErr.message}`);
      } else {
        settled++;
      }
    } catch (err) {
      errors.push(`row ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { settled, errors };
}
