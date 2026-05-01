import type { Forecast, ForecastConfidence, MarketCache, Signal } from "./types";
import { easternToday, easternTomorrow } from "./dates";

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
 * Probability mass of N(mean,std) in the bracket using half-integer continuity correction.
 *
 * Kalshi resolves to integer °F, so each bucket owns the half-degree on each side:
 *   "<M°"   → high ≤ M−1°F  → P(X < M−0.5)       = normalCDF(M − 0.5)
 *   "[m,M]°"→ high is m…M°F → P(m−0.5 < X < M+0.5) = normalCDF(M+0.5) − normalCDF(m−0.5)
 *   ">m°"   → high ≥ m+1°F  → P(X > m+0.5)        = 1 − normalCDF(m + 0.5)
 *
 * Without this correction, a "<64°" bracket with forecast=64° integrates to
 * normalCDF(64,64,σ) = 50% — the half-distribution bug.
 *
 * Returns a 0–100 integer, floored at 1 so every bracket always has a defined edge.
 */
function bracketProb(range: BracketRange, mean: number, std: number): number {
  const { min, max } = range;
  let p: number;
  if      (min === null && max === null) p = 1;
  else if (min === null)  p = normalCDF(max! - 0.5,  mean, std);                             // <M°
  else if (max === null)  p = 1 - normalCDF(min + 0.5, mean, std);                           // >m°
  else                    p = normalCDF(max + 0.5, mean, std) - normalCDF(min - 0.5, mean, std); // [m,M]°
  return Math.max(1, Math.round(p * 100));
}

/**
 * Std-dev in °F mapped to UI labels:
 *   very_confident → "High"   ±1.5°  (expert, tight)
 *   confident      → "Medium" ±2°    (default)
 *   uncertain      → "Low"    ±4°    (wide, unsure)
 */
const CONFIDENCE_STD: Record<ForecastConfidence, number> = {
  very_confident: 1.5,
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

export type BracketRelation = "forecast" | "adjacent" | "neutral" | "confirmed" | "likely_winner";

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
  obs_date:        string;              // actual weather observation date (from event key)
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
  // "Between" brackets (both bounds set) are fully inclusive: 50-51° includes both 50 and 65.
  // "Below X" brackets (min = null) are exclusive: <50° does NOT include 50.
  // "Above X" brackets (max = null) are exclusive: >51° does NOT include 51 (51 belongs to 50-51°).
  if (r.min === null) {
    // bottom-open: value < max
    return r.max !== null && value < r.max;
  }
  if (r.max === null) {
    // top-open: value > min (strictly greater — boundary belongs to the bracket below)
    return value > r.min;
  }
  // closed bracket: inclusive on both ends
  return value >= r.min && value <= r.max;
}


/**
 * Midpoint of a finite bracket, e.g. 64-65° → 64.5.
 * Falls back to the raw forecast value for open-ended brackets (no midpoint is defined).
 */
function bracketMidpoint(r: BracketRange, fallback: number): number {
  return r.min !== null && r.max !== null ? (r.min + r.max) / 2 : fallback;
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
  if (edge > -5)   return "neutral";   // narrowed: was > -10
  if (edge > -20)  return "sell";      // NO; was > -25
  return "strong-sell";                // Strong NO; was ≤ -25, now ≤ -20
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

  const todayStr    = easternToday();
  const tomorrowStr = easternTomorrow();

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
    const isToday = obsDate === easternToday();
    const seriesObs   = isToday
      ? (series === "KXHIGHPHIL" ? (observed?.high ?? null) : (observed?.low ?? null))
      : null;

    console.log(
      `[brackets] ${series} ${eventKey}:`,
      `end_date=${endDate}  obs_date=${obsDate}`,
      forecast ? `${cfg?.forecastKey}=${fVal}` : "no forecast",
      seriesObs != null ? `observed=${seriesObs}°F` : "",
    );

    const std = CONFIDENCE_STD[forecast?.forecast_confidence ?? "confident"] ?? 1.5;

    // Snap distribution mean to the midpoint of whichever bracket contains the forecast.
    // Without this, a forecast sitting on a bracket's lower edge (e.g. 64°F in 64-65°)
    // splits the distribution 50/50 and inflates the bracket below it.
    let effectiveMean: number | undefined = fVal;
    if (fVal !== undefined && fVal !== null && seriesObs === null) {
      for (const m of eventMarkets) {
        const r = parseBracketRange(m.question);
        if (inRange(fVal, r)) {
          effectiveMean = bracketMidpoint(r, fVal);
          break;
        }
      }
    }

    const brackets: BracketMarket[] = eventMarkets.map((m) => {
      const range   = parseBracketRange(m.question);
      const yes_pct = Math.round(m.yes_price * 100);

      let relation:   BracketRelation = "neutral";
      let confidence  = 0;

      if (seriesObs !== null) {
        // ── Observed outcome mode ────────────────────────────────────────────
        if (inRange(seriesObs, range)) {
          // Low temp: observed low could still be beaten near midnight, so mark
          // as "likely_winner" (trades allowed) rather than locking it as "confirmed"
          relation   = series === "KXLOWTPHIL" ? "likely_winner" : "confirmed";
          confidence = 92;
        } else {
          relation   = "neutral";
          confidence = 5;
        }
      } else if (effectiveMean !== undefined && effectiveMean !== null) {
        // ── Normal distribution model ────────────────────────────────────────
        // Use effectiveMean (bracket midpoint) so the forecast bracket always
        // receives the peak probability mass.  Relation tags use raw fVal so
        // "YOUR FORECAST" still marks the correct bracket.
        confidence = bracketProb(range, effectiveMean, std);
        if      (fVal !== undefined && inRange(fVal, range))    relation = "forecast";
        else if (fVal !== undefined && isAdjacent(fVal, range)) relation = "adjacent";
        else                                                     relation = "neutral";
      }

      const edge   = confidence > 0 ? confidence - yes_pct : 0;
      const signal = toSignal(edge);

      // ── Forecast Bracket Protection ─────────────────────────────────────────
      // If this bracket IS our forecast, we cannot logically recommend NO — that
      // would mean "we think the temp lands here AND it doesn't land here."
      // Rule: forecast bracket is ALWAYS trade_side = "YES", regardless of edge.
      //   Positive edge    → Buy/Strong Buy + Trade (normal)
      //   Near-zero edge   → Neutral + Trade + "fairly priced" note
      //   Negative edge    → Neutral + Trade + "market overconfident" note
      // The UI (BracketRow) handles the note and signal capping.
      const trade_side: "YES" | "NO" | null =
        relation === "forecast"
          ? "YES"
          : signal === "strong-buy" || signal === "buy"         ? "YES"
          : signal === "sell"       || signal === "strong-sell" ? "NO"
          : null;

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

    // ── Cascading NO ──────────────────────────────────────────────────────────
    // If bracket X is flagged NO, every bracket further from the forecast in the
    // same direction must also be NO — probability is monotonically decreasing
    // away from the mode, so P(<64°) ≤ P(64-65°).  This prevents the absurd case
    // where an adjacent bracket is NO but the even-further bracket is Neutral.
    // Applied only when a forecast bracket exists (confirmed/no-forecast markets
    // don't need it and have no "forecast" relation to anchor on).
    const fIdx = brackets.findIndex((b) => b.relation === "forecast");
    if (fIdx >= 0) {
      // Walk below the forecast (indices fIdx-1 → 0)
      let cascade = false;
      for (let i = fIdx - 1; i >= 0; i--) {
        if (brackets[i].trade_side === "NO") {
          cascade = true;
        } else if (cascade) {
          brackets[i] = { ...brackets[i], signal: "sell", trade_side: "NO" };
        }
      }
      // Walk above the forecast (indices fIdx+1 → end)
      cascade = false;
      for (let i = fIdx + 1; i < brackets.length; i++) {
        if (brackets[i].trade_side === "NO") {
          cascade = true;
        } else if (cascade) {
          brackets[i] = { ...brackets[i], signal: "sell", trade_side: "NO" };
        }
      }
    }

    // Diagnostic: log probability distribution so we can verify the math
    if (fVal !== undefined && fVal !== null && seriesObs === null) {
      const meanLabel = effectiveMean !== fVal ? `${fVal}°→${effectiveMean}°` : `${fVal}°`;
      const dist = brackets
        .map((b) => `${b.range.label}=${b.confidence}%${b.relation === "forecast" ? "*" : ""} (k=${b.yes_pct}%, e=${b.edge > 0 ? "+" : ""}${b.edge})`)
        .join("  ");
      const total = brackets.filter((b) => b.confidence > 1).reduce((s, b) => s + b.confidence, 0);
      console.log(`[brackets] ${series} N(mean=${meanLabel}, σ=${std}) Σ≈${total}%: ${dist}`);
    }

    // Best YES: prefer the forecast bracket only when it has POSITIVE edge
    // (i.e. Kalshi is underpricing our forecast — a real opportunity).
    // When forecast is overpriced (edge ≤ 0), fall back to the highest-edge
    // non-forecast YES bracket — that's the "best alternative" shown in the banner.
    // The banner component then adds a note about the overpriced forecast bracket.
    const forecastBkt = brackets.find((b) => b.relation === "forecast");
    const bestYes: BracketMarket | null =
      (forecastBkt?.trade_side === "YES" && (forecastBkt?.edge ?? 0) > 0)
        ? forecastBkt
        : ([...brackets]
            .filter((b) => b.trade_side === "YES" && b.relation !== "forecast")
            .sort((a, b) => b.edge - a.edge)[0] ?? null);

    // Forecast bracket is never NO (see trade_side logic above), but be explicit:
    // never let the best-trade banner recommend NO on the bracket that IS our forecast.
    const bestNo = [...brackets]
      .filter((b) => b.trade_side === "NO" && b.relation !== "forecast")
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
      obs_date:       obsDate,
      brackets,
      best,
      forecast_value: fVal ?? null,
      observed_value: seriesObs,
    });
  }

  // Sort descending by close date (furthest future first); series is secondary
  groups.sort((a, b) => {
    const dateCmp = b.end_date.localeCompare(a.end_date);
    return dateCmp !== 0 ? dateCmp : a.series.localeCompare(b.series);
  });

  return { groups, singles };
}
