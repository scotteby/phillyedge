import type { Forecast, ForecastConfidence, MarketCache, Signal } from "./types";

// ── Normal distribution ────────────────────────────────────────────────────────

/** Abramowitz & Stegun erf approximation — max error 1.5×10⁻⁷. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax   = Math.abs(x);
  const t    = 1 / (1 + 0.3275911 * ax);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-ax * ax));
}

/** P(X ≤ x) for X ~ N(mean, std). */
function normalCDF(x: number, mean: number, std: number): number {
  return 0.5 * (1 + erf((x - mean) / (std * Math.SQRT2)));
}

/**
 * Probability mass of N(mean,std) in the bracket, matching Kalshi's resolution:
 *   "<M"    → P(X < M)         = normalCDF(M)
 *   "[m,M]" → P(m ≤ X ≤ M)    ≈ normalCDF(M) − normalCDF(m)
 *   ">m"    → P(X ≥ m+1)       = 1 − normalCDF(m+1)
 * Returns a 0–100 integer.
 */
function bracketProb(range: BracketRange, mean: number, std: number): number {
  const { min, max } = range;
  let p: number;
  if      (min === null && max === null) p = 1;
  else if (min === null)  p = normalCDF(max!, mean, std);
  else if (max === null)  p = 1 - normalCDF(min + 1, mean, std);
  else                    p = normalCDF(max, mean, std) - normalCDF(min, mean, std);
  return Math.max(1, Math.round(p * 100)); // floor at 1% so edge is always defined
}

/** Std-dev in °F for each confidence level. */
const CONFIDENCE_STD: Record<ForecastConfidence, number> = {
  very_confident: 1.0,
  confident:      2.0,
  uncertain:      4.0,
};

// ── Series config ─────────────────────────────────────────────────────────────

export const BRACKET_SERIES: Record<string, { title: string; forecastKey: "high_temp" | "low_temp" }> = {
  KXHIGHPHIL: { title: "Highest Temperature in Philadelphia Today", forecastKey: "high_temp" },
  KXLOWTPHIL: { title: "Lowest Temperature in Philadelphia Today",  forecastKey: "low_temp"  },
};

export function isBracketSeries(marketId: string): boolean {
  return marketId.split("-")[0].toUpperCase() in BRACKET_SERIES;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BracketRange {
  min:   number | null; // inclusive lower bound, null = -∞
  max:   number | null; // exclusive upper bound, null = +∞
  label: string;        // display label extracted from Kalshi title
}

export type BracketRelation = "forecast" | "adjacent" | "neutral" | "confirmed";

export interface BracketMarket {
  market_id:   string;
  question:    string;
  end_date:    string;
  yes_price:   number;
  yes_pct:     number;
  volume:      number;
  range:       BracketRange;
  relation:    BracketRelation;
  confidence:  number;            // our estimated probability 0–100
  edge:        number;            // confidence − yes_pct (positive = YES edge, negative = NO edge)
  signal:      Signal;
  trade_side:  "YES" | "NO" | null; // recommended side, null when neutral or no forecast
}

export interface BracketGroup {
  series:          string;
  event_key:       string;
  title:           string;
  end_date:        string;
  brackets:        BracketMarket[];     // sorted low → high
  best:            BracketMarket | null; // highest-edge bracket with a view
  forecast_value:  number | null;        // our forecast temp for this series
  observed_value:  number | null;        // NWS observed temp — non-null = outcome known
}

// ── Label extraction ──────────────────────────────────────────────────────────
// Kalshi title format: "Will the high temp in Philadelphia be 66-67° on Apr 29, 2026?"
// We extract just the range clause: "66-67°"

function extractRangeLabel(question: string): string {
  // Match the range description between "be " and " on <date>"
  const m = question.match(/\bbe\s+(.+?)\s+on\s+\w{3}\s+\d+/i);
  if (m) return m[1].trim();
  // Fallback: return the full question (already stripped of ** markdown)
  return question;
}

// ── Range parsing ─────────────────────────────────────────────────────────────
// Parses numeric bounds from the Kalshi question for in-range / adjacent logic.
// The display label comes from extractRangeLabel(), not this function.

export function parseBracketRange(question: string): BracketRange {
  const label = extractRangeLabel(question);
  const t     = question.toLowerCase();

  // "between 68°f and 70°f" | "68 to 70" | "68°–70°" | "66-67°"
  const between =
    t.match(/between\s+(\d+)[°\s].*?and\s+(\d+)/i) ||
    t.match(/(\d+)°?\s*(?:to|–|-)\s*(\d+)°?/);
  if (between) {
    return { min: parseInt(between[1]), max: parseInt(between[2]), label };
  }

  // "at or above 72" | "above 72" | ">72" | "≥72"
  const above =
    t.match(/(?:at\s+or\s+)?above\s+(\d+)/i) ||
    t.match(/[>≥]=?\s*(\d+)/);
  if (above) {
    return { min: parseInt(above[1]), max: null, label };
  }

  // "at or below 64" | "below 64" | "<64" | "≤64"
  const below =
    t.match(/(?:at\s+or\s+)?below\s+(\d+)/i) ||
    t.match(/[<≤]=?\s*(\d+)/);
  if (below) {
    return { min: null, max: parseInt(below[1]), label };
  }

  return { min: null, max: null, label };
}

// ── Bracket range logic ───────────────────────────────────────────────────────

function inRange(value: number, r: BracketRange): boolean {
  const aboveMin = r.min === null || value >= r.min;
  // "Between" brackets (both bounds set) are fully inclusive: 64-65° includes both 64 and 65.
  // "Below X" brackets (min = null) are exclusive: <64° does NOT include 64.
  const belowMax = r.max === null || (r.min !== null ? value <= r.max : value < r.max);
  return aboveMin && belowMax;
}


function isAdjacent(value: number, r: BracketRange, withinDeg = 2): boolean {
  if (inRange(value, r)) return false;
  if (r.min !== null && value < r.min && r.min - value <= withinDeg) return true;
  if (r.max !== null && value >= r.max && value - r.max < withinDeg) return true;
  return false;
}

function toSignal(edge: number): Signal {
  if (edge >= 25)  return "strong-buy";
  if (edge >= 10)  return "buy";
  if (edge > -10)  return "neutral";
  if (edge > -25)  return "sell";
  return "strong-sell";
}

// ── Observation date extraction ───────────────────────────────────────────────
// The event key encodes the calendar day the weather is measured: "KXHIGHPHIL-26APR29"
// → 2026-04-29.  This is NOT the same as end_date, which is the market's close
// time (often midnight the following day for overnight low-temp markets).

const MONTH_MAP: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

function observationDate(eventKey: string): string | null {
  const parts = eventKey.toUpperCase().split("-");
  for (let i = parts.length - 1; i >= 0; i--) {
    const m = parts[i].match(/^(\d{2})([A-Z]{3})(\d{2})$/);
    if (m) {
      const mm = MONTH_MAP[m[2]];
      if (mm) return `20${m[1]}-${mm}-${m[3]}`;
    }
  }
  return null;
}

// ── Dynamic group title ───────────────────────────────────────────────────────

const BASE_TITLES: Record<string, string> = {
  KXHIGHPHIL: "High Temperature Philadelphia",
  KXLOWTPHIL: "Low Temperature Philadelphia",
};

function groupTitle(series: string, eventKey: string): string {
  const base    = BASE_TITLES[series] ?? `${series} Markets`;
  const obsDate = observationDate(eventKey);
  if (!obsDate) return base;

  const dateLabel = new Date(obsDate + "T12:00:00").toLocaleDateString("en-US", {
    month: "short", day: "numeric",
  });

  const todayStr    = new Date().toISOString().split("T")[0];
  const tomorrowStr = new Date(Date.now() + 86_400_000).toISOString().split("T")[0];

  if (obsDate === todayStr)    return `${base} · Today, ${dateLabel}`;
  if (obsDate === tomorrowStr) return `${base} · Tomorrow, ${dateLabel}`;
  return `${base} · ${dateLabel}`;
}

// ── Main grouping function ────────────────────────────────────────────────────

export function groupBracketMarkets(
  markets:   MarketCache[],
  forecasts: Forecast[],
  observed?: { low: number | null; high: number | null }
): { groups: BracketGroup[]; singles: MarketCache[] } {
  const bracketMarkets = markets.filter((m) => isBracketSeries(m.market_id));
  const singles        = markets.filter((m) => !isBracketSeries(m.market_id));

  // Group by event key: first two hyphen segments → "KXHIGHPHIL-26APR29"
  const eventMap = new Map<string, MarketCache[]>();
  for (const m of bracketMarkets) {
    const parts = m.market_id.toUpperCase().split("-");
    const key   = parts.length >= 2 ? `${parts[0]}-${parts[1]}` : parts[0];
    if (!eventMap.has(key)) eventMap.set(key, []);
    eventMap.get(key)!.push(m);
  }

  const groups: BracketGroup[] = [];

  for (const [eventKey, eventMarkets] of eventMap) {
    const series  = eventMarkets[0].market_id.split("-")[0].toUpperCase();
    const cfg     = BRACKET_SERIES[series];
    const endDate = eventMarkets[0].end_date;

    // Use the observation date (from event key) for forecast lookup.
    // end_date is the market close time — for low-temp markets it's midnight
    // the next calendar day, so matching on it finds the wrong forecast row.
    const obsDate  = observationDate(eventKey) ?? endDate;
    const forecast = forecasts.find((f) => f.target_date === obsDate);
    const fVal = forecast
      ? (forecast[cfg?.forecastKey ?? "high_temp"] as number | undefined)
      : undefined;

    // Observed NWS temp — only applies to today's markets
    const todayStr    = new Date().toISOString().split("T")[0];
    const isToday     = obsDate === todayStr;
    const seriesObs   = isToday
      ? (series === "KXHIGHPHIL" ? (observed?.high ?? null) : (observed?.low ?? null))
      : null;

    console.log(
      `[brackets] ${series} ${eventKey}:`,
      `end_date=${endDate}  obs_date=${obsDate}`,
      forecast ? `${cfg?.forecastKey}=${fVal}` : "no forecast",
      seriesObs != null ? `observed=${seriesObs}°F` : "",
    );

    const std = CONFIDENCE_STD[forecast?.forecast_confidence ?? "confident"] ?? 3.0;

    const brackets: BracketMarket[] = eventMarkets.map((m) => {
      const range   = parseBracketRange(m.question);
      const yes_pct = Math.round(m.yes_price * 100);

      let relation:   BracketRelation = "neutral";
      let confidence  = 0;

      if (seriesObs !== null) {
        // ── Observed outcome mode ────────────────────────────────────────────
        if (inRange(seriesObs, range)) {
          relation   = "confirmed";
          confidence = 92;
        } else {
          relation   = "neutral";
          confidence = 5;
        }
      } else if (fVal !== undefined && fVal !== null) {
        // ── Normal distribution model ────────────────────────────────────────
        // Probability mass of N(fVal, std) within this bracket's bounds.
        confidence = bracketProb(range, fVal, std);
        if      (inRange(fVal, range))    relation = "forecast";
        else if (isAdjacent(fVal, range)) relation = "adjacent";
        else                              relation = "neutral";
      }

      const edge   = confidence > 0 ? confidence - yes_pct : 0;
      const signal = toSignal(edge);
      const trade_side: "YES" | "NO" | null =
        signal === "strong-buy" || signal === "buy"       ? "YES" :
        signal === "sell"       || signal === "strong-sell" ? "NO"  : null;

      return {
        market_id: m.market_id,
        question:  m.question,
        end_date:  m.end_date,
        yes_price: m.yes_price,
        yes_pct,
        volume:    m.volume,
        range,
        relation,
        confidence,
        edge,
        signal,
        trade_side,
      };
    });

    // Sort brackets ascending by lower bound (null min = −∞ goes first)
    brackets.sort((a, b) => (a.range.min ?? -999) - (b.range.min ?? -999));

    // Best trade = highest absolute edge across YES and NO opportunities
    const bestYes = [...brackets]
      .filter((b) => b.trade_side === "YES")
      .sort((a, b) => b.edge - a.edge)[0] ?? null;

    const bestNo = [...brackets]
      .filter((b) => b.trade_side === "NO")
      .sort((a, b) => a.edge - b.edge)[0] ?? null; // most-negative edge = strongest NO

    let best: BracketMarket | null = null;
    if (bestYes && bestNo) {
      best = bestYes.edge >= Math.abs(bestNo.edge) ? bestYes : bestNo;
    } else {
      best = bestYes ?? bestNo;
    }

    groups.push({
      series,
      event_key:      eventKey,
      title:          groupTitle(series, eventKey),
      end_date:       endDate,
      brackets,
      best,
      forecast_value: fVal ?? null,
      observed_value: seriesObs,
    });
  }

  // High temp before low temp, then by date
  groups.sort((a, b) => {
    const seriesCmp = a.series.localeCompare(b.series);
    return seriesCmp !== 0 ? seriesCmp : a.end_date.localeCompare(b.end_date);
  });

  return { groups, singles };
}
