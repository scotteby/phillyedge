/**
 * Trading strategy helpers — primary / hedge two-trade model.
 *
 * Our strategy is exactly two trades per market:
 *   1. PRIMARY  — forecast bracket, always YES
 *   2. HEDGE    — adjacent bracket closest to forecast temp, always YES
 *
 * We never recommend NO positions.
 */

import type { BracketMarket } from "./brackets";

// ── Secondary bracket selection ───────────────────────────────────────────────

/**
 * Select the secondary (hedge) bracket for a group.
 *
 * Rules:
 *  1. Returns null when no forecast bracket exists.
 *  2. Returns null when the forecast bracket is open-ended (lowest / highest bracket).
 *  3. Among the two immediately adjacent brackets (sharing an exact boundary with the
 *     forecast bracket), picks the one whose shared boundary is nearest to the forecast
 *     temperature.
 *  4. Tie-break: prefer the bracket ABOVE the forecast.
 *
 * @param brackets      All BracketMarket items for the group (any order).
 * @param forecastValue The forecast temperature (integer °F).
 */
export function selectSecondaryBracket(
  brackets:      BracketMarket[],
  forecastValue: number,
): BracketMarket | null {
  // Accept observed-mode relations as equivalent to "forecast"
  const forecastBkt = brackets.find(
    (b) => b.relation === "forecast" || b.relation === "likely_winner" || b.relation === "confirmed"
  );
  if (!forecastBkt) return null;

  const { min: fMin, max: fMax } = forecastBkt.range;

  // No hedge for open-ended (lowest / highest) forecast brackets
  if (fMin === null || fMax === null) return null;

  // Sort brackets ascending by lower bound (null min = −∞ first).
  // This handles both contiguous (64-66, 66-68) and non-contiguous
  // (63-64, 65-66, 67-68) Kalshi bracket structures — we use positional
  // neighbours rather than requiring exact shared boundaries.
  const sorted = [...brackets].sort(
    (a, b) => (a.range.min ?? -Infinity) - (b.range.min ?? -Infinity),
  );

  const fIdx = sorted.findIndex((b) => b.market_id === forecastBkt.market_id);
  if (fIdx < 0) return null;

  const bracketBelow = fIdx > 0                    ? sorted[fIdx - 1] : null;
  const bracketAbove = fIdx < sorted.length - 1    ? sorted[fIdx + 1] : null;

  if (!bracketBelow && !bracketAbove) return null;
  if (!bracketBelow) return bracketAbove!;
  if (!bracketAbove) return bracketBelow;

  // Use the primary bracket's own edges as reference.
  // Hedge on the side where the forecast is NEAREST to the boundary —
  // that's the direction you'd spill into if the forecast is even slightly off.
  //
  // e.g. forecast=48 in 48-49°: distBelow=0, distAbove=1 → hedge below (46-47°)
  //      forecast=66 in 65-66°: distBelow=1, distAbove=0 → hedge above (67-68°)
  //      forecast at center:    distBelow=distAbove      → tie-break: prefer above
  const distBelow = forecastValue - fMin;
  const distAbove = fMax - forecastValue;

  return distBelow < distAbove ? bracketBelow : bracketAbove;
}

// ── Hedge sizing ──────────────────────────────────────────────────────────────

export interface HedgeSizeResult {
  secondaryContracts: number;
  secondarySize:      number;   // in dollars
}

/**
 * Calculate the hedge (secondary) position size.
 *
 * Goal: if the primary fails (the temp misses) and the secondary wins (it caught
 * the miss), the secondary payout covers `coverageRatio` of the primary cost.
 *
 * Formula:
 *   primaryLoss         = primaryContracts × primaryPrice
 *   secondaryContracts  = ceil(primaryLoss × coverageRatio / (1 − secondaryPrice))
 *   secondarySize       = secondaryContracts × secondaryPrice
 *
 * @param primaryContracts  Number of primary contracts purchased.
 * @param primaryPrice      Per-contract cost of the primary leg as a 0–1 decimal.
 * @param secondaryPrice    Per-contract cost of the secondary leg as a 0–1 decimal.
 * @param coverageRatio     Fraction of primary loss to cover (0.25 / 0.50 / 0.75 / 1.00).
 */
export function calcHedgeSize(
  primaryContracts: number,
  primaryPrice:     number,
  secondaryPrice:   number,
  coverageRatio:    number,
): HedgeSizeResult {
  if (
    primaryContracts <= 0 ||
    primaryPrice     <= 0 ||
    secondaryPrice   <= 0 ||
    secondaryPrice   >= 1
  ) {
    return { secondaryContracts: 0, secondarySize: 0 };
  }

  const primaryLoss        = primaryContracts * primaryPrice;
  const profitPerContract  = 1 - secondaryPrice;
  const secondaryContracts = Math.ceil((primaryLoss * coverageRatio) / profitPerContract);
  const secondarySize      = secondaryContracts * secondaryPrice;

  return { secondaryContracts, secondarySize };
}

// ── Default leg builder ───────────────────────────────────────────────────────

/**
 * Build the two default position legs (primary + hedge) for a bracket group.
 *
 * The budget parameter is used to estimate contract counts so that the hedge
 * formula can produce meaningful dollar amounts.  The returned legs have pct
 * values that sum to 100 — primary dominates, hedge is the computed remainder.
 *
 * Returns an empty array when there is no forecast bracket.
 */
export interface DefaultLeg {
  market_id:   string;
  bracket:     BracketMarket;
  side:        "YES";
  pct:         number;   // 0–100, sums to 100 across returned legs
  isPrimary:   boolean;
}

export function buildStrategyLegs(
  brackets:      BracketMarket[],
  coverageRatio: number,
  budget:        number = 20,
): DefaultLeg[] {
  const primaryBkt = brackets.find((b) => b.bracketRole === "primary") ?? null;
  const hedgeBkt   = brackets.find((b) => b.bracketRole === "hedge")   ?? null;

  if (!primaryBkt) return [];

  const primaryPrice     = primaryBkt.yes_price;
  const primaryContracts = Math.max(1, Math.floor(budget / primaryPrice));

  let primaryPct = 100;
  let hedgePct   = 0;

  if (hedgeBkt) {
    const { secondarySize } = calcHedgeSize(
      primaryContracts,
      primaryPrice,
      hedgeBkt.yes_price,
      coverageRatio,
    );
    const total  = budget + secondarySize;
    primaryPct   = Math.round((budget / total) * 100);
    hedgePct     = 100 - primaryPct;
  }

  const legs: DefaultLeg[] = [
    { market_id: primaryBkt.market_id, bracket: primaryBkt, side: "YES", pct: primaryPct, isPrimary: true },
  ];

  if (hedgeBkt && hedgePct > 0) {
    legs.push({
      market_id: hedgeBkt.market_id,
      bracket:   hedgeBkt,
      side:      "YES",
      pct:       hedgePct,
      isPrimary: false,
    });
  }

  return legs;
}

// ── Default coverage ratio ────────────────────────────────────────────────────

export const DEFAULT_HEDGE_COVERAGE = 0.5;
export const HEDGE_COVERAGE_KEY     = "hedge_coverage_ratio";

/** Read coverage ratio from localStorage (client only). Falls back to default. */
export function readHedgeCoverage(): number {
  if (typeof window === "undefined") return DEFAULT_HEDGE_COVERAGE;
  const v = parseFloat(localStorage.getItem(HEDGE_COVERAGE_KEY) ?? "");
  return isNaN(v) || v <= 0 || v > 1 ? DEFAULT_HEDGE_COVERAGE : v;
}

/** Write coverage ratio to localStorage. */
export function writeHedgeCoverage(ratio: number): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(HEDGE_COVERAGE_KEY, String(ratio));
}
