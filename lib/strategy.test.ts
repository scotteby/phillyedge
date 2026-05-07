/**
 * Unit tests for lib/strategy.ts
 *
 * Run with:  npx tsx --test lib/strategy.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  selectSecondaryBracket,
  calcHedgeSize,
  buildStrategyLegs,
} from "./strategy";
import type { BracketMarket } from "./brackets";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeBracket(
  overrides: Partial<BracketMarket> & { min: number | null; max: number | null },
): BracketMarket {
  const { min, max } = overrides;
  const label =
    min === null  ? `<${max}°`  :
    max === null  ? `>${min}°`  :
    `${min}-${max}°`;
  const mid  = min !== null && max !== null ? (min + max) / 2 : (min ?? max ?? 70);
  const yesP = 0.30;
  return {
    market_id:  overrides.market_id  ?? `MKT-${label}`,
    question:   overrides.question   ?? `Will the high be ${label} on May 1?`,
    end_date:   overrides.end_date   ?? "2026-05-01",
    yes_price:  overrides.yes_price  ?? yesP,
    yes_pct:    overrides.yes_pct    ?? Math.round(yesP * 100),
    volume:     overrides.volume     ?? 1000,
    range:      { min, max, label },
    relation:   overrides.relation   ?? "neutral",
    confidence: overrides.confidence ?? 40,
    edge:       overrides.edge       ?? 10,
    signal:     overrides.signal     ?? "buy",
    trade_side: overrides.trade_side ?? "YES",
    bracketRole: overrides.bracketRole ?? null,
    ...overrides,
  };
}

// A standard set: five contiguous brackets covering <64, 64-66, 66-68, 68-70, >70
function makeStdBrackets(forecastMin: number, forecastMax: number): BracketMarket[] {
  const all = [
    makeBracket({ market_id: "A", min: null, max: 64, relation: "neutral" }),
    makeBracket({ market_id: "B", min: 64, max: 66, relation: "neutral" }),
    makeBracket({ market_id: "C", min: 66, max: 68, relation: "neutral" }),
    makeBracket({ market_id: "D", min: 68, max: 70, relation: "neutral" }),
    makeBracket({ market_id: "E", min: 70, max: null, relation: "neutral" }),
  ];
  // Mark the forecast bracket
  return all.map((b) =>
    b.range.min === forecastMin && b.range.max === forecastMax
      ? { ...b, relation: "forecast" as const }
      : b,
  );
}

// ── selectSecondaryBracket ────────────────────────────────────────────────────

describe("selectSecondaryBracket", () => {
  test("returns null when no forecast bracket exists", () => {
    const brackets = makeStdBrackets(64, 66).map((b) => ({ ...b, relation: "neutral" as const }));
    assert.strictEqual(selectSecondaryBracket(brackets, 65), null);
  });

  test("returns null when forecast bracket is the lowest (min=null)", () => {
    // Mark the <64° bracket as the forecast
    const all = [
      makeBracket({ market_id: "A", min: null, max: 64, relation: "forecast" }),
      makeBracket({ market_id: "B", min: 64, max: 66, relation: "neutral" }),
    ];
    assert.strictEqual(selectSecondaryBracket(all, 62), null);
  });

  test("returns null when forecast bracket is the highest (max=null)", () => {
    const all = [
      makeBracket({ market_id: "A", min: 66, max: 68, relation: "neutral" }),
      makeBracket({ market_id: "B", min: 68, max: null, relation: "forecast" }),
    ];
    assert.strictEqual(selectSecondaryBracket(all, 70), null);
  });

  test("picks the bracket below when forecast is near the lower boundary", () => {
    // forecast=65, bracket C=66-68 → lower dist = 65-66 = -1 (impossible — 65 < 66)
    // Realistically, forecast=66 in bracket 66-68: distBelow=66-66=0, distAbove=68-66=2 → pick below
    const brackets = makeStdBrackets(66, 68);
    const result   = selectSecondaryBracket(brackets, 66);
    assert.ok(result, "should find a secondary bracket");
    // bracketBelow = B (64-66), bracketAbove = D (68-70)
    // distBelow = 66 - 66 = 0, distAbove = 68 - 66 = 2 → pick below
    assert.strictEqual(result!.market_id, "B");
  });

  test("picks the bracket above when forecast is near the upper boundary", () => {
    // forecast=67, bracket C=66-68: distBelow = 67-66 = 1, distAbove = 68-67 = 1 → tie → above
    const brackets = makeStdBrackets(66, 68);
    const result   = selectSecondaryBracket(brackets, 67);
    assert.ok(result);
    // Tie (both dist=1) → prefer bracket above → D (68-70)
    assert.strictEqual(result!.market_id, "D");
  });

  test("tie-break: prefers bracket above when distances are equal", () => {
    // forecast exactly in the middle of 66-68 → distBelow=1, distAbove=1 → pick above
    const brackets = makeStdBrackets(66, 68);
    assert.strictEqual(selectSecondaryBracket(brackets, 67)!.market_id, "D");
  });

  test("picks the bracket above when forecast is near the upper boundary (67 in 66-68 closer to top)", () => {
    // forecast=68, bracket D=68-70: distBelow = 68-68 = 0, distAbove = 70-68 = 2 → below
    const brackets = makeStdBrackets(68, 70);
    const result   = selectSecondaryBracket(brackets, 68);
    assert.ok(result);
    // bracketBelow = C (66-68), bracketAbove = E (>70)
    // distBelow = 68-68 = 0, distAbove = 70-68 = 2 → pick below (C)
    assert.strictEqual(result!.market_id, "C");
  });

  test("returns only above bracket when there is no bracket below (first finite bracket)", () => {
    // brackets: <64 (open) | 64-66 (forecast) | 66-68
    const all = [
      makeBracket({ market_id: "A", min: null, max: 64, relation: "neutral" }),
      makeBracket({ market_id: "B", min: 64, max: 66, relation: "forecast" }),
      makeBracket({ market_id: "C", min: 66, max: 68, relation: "neutral" }),
    ];
    // bracketBelow for B (min=64) would need max=64 → A has max=64 ✓
    // bracketAbove for B (max=66) would need min=66 → C has min=66 ✓
    // distBelow = forecast - fMin = 65 - 64 = 1
    // distAbove = fMax - forecast = 66 - 65 = 1 → tie → prefer above (C)
    const result = selectSecondaryBracket(all, 65);
    assert.strictEqual(result!.market_id, "C");
  });
});

// ── calcHedgeSize ─────────────────────────────────────────────────────────────

describe("calcHedgeSize", () => {
  test("returns zeros when primaryContracts=0", () => {
    const r = calcHedgeSize(0, 0.40, 0.30, 0.5);
    assert.strictEqual(r.secondaryContracts, 0);
    assert.strictEqual(r.secondarySize, 0);
  });

  test("returns zeros when secondaryPrice=0", () => {
    const r = calcHedgeSize(50, 0.40, 0, 0.5);
    assert.strictEqual(r.secondaryContracts, 0);
  });

  test("returns zeros when secondaryPrice=1 (no profit possible)", () => {
    const r = calcHedgeSize(50, 0.40, 1.0, 0.5);
    assert.strictEqual(r.secondaryContracts, 0);
  });

  test("50% coverage: 50 contracts @ 40¢ primary, 30¢ secondary", () => {
    // primaryLoss = 50 × 0.40 = 20
    // secondaryContracts = ceil(20 × 0.5 / 0.70) = ceil(14.28) = 15
    // secondarySize = 15 × 0.30 = 4.50
    const r = calcHedgeSize(50, 0.40, 0.30, 0.5);
    assert.strictEqual(r.secondaryContracts, 15);
    assert.ok(Math.abs(r.secondarySize - 4.50) < 0.001);
  });

  test("100% coverage: 50 contracts @ 40¢ primary, 30¢ secondary", () => {
    // secondaryContracts = ceil(20 × 1.0 / 0.70) = ceil(28.57) = 29
    // secondarySize = 29 × 0.30 = 8.70
    const r = calcHedgeSize(50, 0.40, 0.30, 1.0);
    assert.strictEqual(r.secondaryContracts, 29);
    assert.ok(Math.abs(r.secondarySize - 8.70) < 0.001);
  });

  test("25% coverage: 50 contracts @ 40¢ primary, 30¢ secondary", () => {
    // secondaryContracts = ceil(20 × 0.25 / 0.70) = ceil(7.14) = 8
    // secondarySize = 8 × 0.30 = 2.40
    const r = calcHedgeSize(50, 0.40, 0.30, 0.25);
    assert.strictEqual(r.secondaryContracts, 8);
    assert.ok(Math.abs(r.secondarySize - 2.40) < 0.001);
  });

  test("50% coverage: 100 contracts @ 50¢ primary, 20¢ secondary", () => {
    // primaryLoss = 100 × 0.50 = 50
    // secondaryContracts = ceil(50 × 0.5 / 0.80) = ceil(31.25) = 32
    // secondarySize = 32 × 0.20 = 6.40
    const r = calcHedgeSize(100, 0.50, 0.20, 0.5);
    assert.strictEqual(r.secondaryContracts, 32);
    assert.ok(Math.abs(r.secondarySize - 6.40) < 0.001);
  });
});

// ── buildStrategyLegs ─────────────────────────────────────────────────────────

describe("buildStrategyLegs", () => {
  function makePrimaryBkt(): BracketMarket {
    return {
      ...makeBracket({ market_id: "PRIMARY", min: 66, max: 68, relation: "forecast", yes_price: 0.40 }),
      bracketRole: "primary",
    };
  }

  function makeHedgeBkt(): BracketMarket {
    return {
      ...makeBracket({ market_id: "HEDGE", min: 68, max: 70, relation: "adjacent", yes_price: 0.30 }),
      bracketRole: "hedge",
    };
  }

  test("returns empty array when no primary bracket exists", () => {
    const brackets = [makeHedgeBkt()];
    const legs = buildStrategyLegs(brackets, 0.5, 20);
    assert.strictEqual(legs.length, 0);
  });

  test("returns only primary leg when no hedge bracket exists", () => {
    const brackets = [makePrimaryBkt()];
    const legs = buildStrategyLegs(brackets, 0.5, 20);
    assert.strictEqual(legs.length, 1);
    assert.strictEqual(legs[0].market_id, "PRIMARY");
    assert.strictEqual(legs[0].isPrimary, true);
    assert.strictEqual(legs[0].pct, 100);
    assert.strictEqual(legs[0].side, "YES");
  });

  test("returns primary + hedge legs that sum to 100%", () => {
    const brackets = [makePrimaryBkt(), makeHedgeBkt()];
    const legs = buildStrategyLegs(brackets, 0.5, 20);
    assert.strictEqual(legs.length, 2);
    const total = legs.reduce((s, l) => s + l.pct, 0);
    assert.strictEqual(total, 100);
  });

  test("primary leg has larger pct than hedge leg", () => {
    const brackets = [makePrimaryBkt(), makeHedgeBkt()];
    const legs = buildStrategyLegs(brackets, 0.5, 20);
    const primary = legs.find((l) => l.isPrimary)!;
    const hedge   = legs.find((l) => !l.isPrimary)!;
    assert.ok(primary.pct > hedge.pct, "primary pct should be larger than hedge pct");
  });

  test("higher coverage ratio → larger hedge pct", () => {
    const brackets = [makePrimaryBkt(), makeHedgeBkt()];
    const legs50   = buildStrategyLegs(brackets, 0.50, 20);
    const legs100  = buildStrategyLegs(brackets, 1.00, 20);
    const hedge50  = legs50.find((l) => !l.isPrimary)!.pct;
    const hedge100 = legs100.find((l) => !l.isPrimary)!.pct;
    assert.ok(hedge100 > hedge50, "100% coverage should give larger hedge pct");
  });

  test("both legs have side=YES", () => {
    const brackets = [makePrimaryBkt(), makeHedgeBkt()];
    const legs = buildStrategyLegs(brackets, 0.5, 20);
    for (const l of legs) {
      assert.strictEqual(l.side, "YES");
    }
  });
});
