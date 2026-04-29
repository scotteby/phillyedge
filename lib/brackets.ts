import type { Forecast, MarketCache, Signal } from "./types";

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

export type BracketRelation = "forecast" | "adjacent" | "neutral";

export interface BracketMarket {
  market_id:  string;
  question:   string;
  end_date:   string;
  yes_price:  number;
  yes_pct:    number;
  volume:     number;
  range:      BracketRange;
  relation:   BracketRelation;
  confidence: number; // our estimated probability 0–100
  edge:       number;
  signal:     Signal;
}

export interface BracketGroup {
  series:         string;
  event_key:      string;
  title:          string;
  end_date:       string;
  brackets:       BracketMarket[];     // sorted low → high
  best:           BracketMarket | null; // highest-edge bracket with a view
  forecast_value: number | null;        // our forecast temp for this series
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
  const belowMax = r.max === null || value < r.max;
  return aboveMin && belowMax;
}

function distToBoundary(value: number, r: BracketRange): number {
  let d = Infinity;
  if (r.min !== null) d = Math.min(d, Math.abs(value - r.min));
  if (r.max !== null) d = Math.min(d, Math.abs(value - r.max));
  return d;
}

function isAdjacent(value: number, r: BracketRange, withinDeg = 2): boolean {
  if (inRange(value, r)) return false;
  if (r.min !== null && value < r.min && r.min - value <= withinDeg) return true;
  if (r.max !== null && value >= r.max && value - r.max < withinDeg) return true;
  return false;
}

function toSignal(edge: number): Signal {
  if (edge >= 25) return "strong-buy";
  if (edge >= 10) return "buy";
  if (edge > -10) return "neutral";
  return "avoid";
}

// ── Main grouping function ────────────────────────────────────────────────────

export function groupBracketMarkets(
  markets:   MarketCache[],
  forecasts: Forecast[]
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

    // Closest forecast for this date
    const forecast = forecasts.find((f) => f.target_date === endDate);
    const fVal = forecast
      ? (forecast[cfg?.forecastKey ?? "high_temp"] as number | undefined)
      : undefined;

    const brackets: BracketMarket[] = eventMarkets.map((m) => {
      const range   = parseBracketRange(m.question);
      const yes_pct = Math.round(m.yes_price * 100);

      // ── Confidence model ───────────────────────────────────────────────────
      // Every bracket gets OUR % so every row shows edge data.
      // When forecast is unavailable, confidence = 0 (no view).
      let relation:   BracketRelation = "neutral";
      let confidence  = 0;

      if (fVal !== undefined && fVal !== null) {
        if (inRange(fVal, range)) {
          // Forecast lands in this bracket
          const dist = distToBoundary(fVal, range);
          relation   = "forecast";
          confidence = dist <= 2 ? 40 : 60; // lower confidence near boundary
        } else if (isAdjacent(fVal, range)) {
          // Forecast is within 2° of this bracket's boundary
          relation   = "adjacent";
          confidence = 25;
        } else {
          // Forecast is clearly outside this bracket
          relation   = "neutral";
          confidence = 5; // very unlikely — useful for NO trades
        }
      }

      const edge = confidence > 0 ? confidence - yes_pct : 0;

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
        signal:    toSignal(edge),
      };
    });

    // Sort brackets ascending by lower bound (null min = −∞ goes first)
    brackets.sort((a, b) => (a.range.min ?? -999) - (b.range.min ?? -999));

    // Best trade = highest positive edge among brackets we have a view on
    const best = [...brackets]
      .filter((b) => b.confidence > 0 && b.edge > 0)
      .sort((a, b) => b.edge - a.edge)[0] ?? null;

    groups.push({
      series,
      event_key:      eventKey,
      title:          cfg?.title ?? `${series} Markets`,
      end_date:       endDate,
      brackets,
      best,
      forecast_value: fVal ?? null,
    });
  }

  // High temp before low temp, then by date
  groups.sort((a, b) => {
    const seriesCmp = a.series.localeCompare(b.series);
    return seriesCmp !== 0 ? seriesCmp : a.end_date.localeCompare(b.end_date);
  });

  return { groups, singles };
}
