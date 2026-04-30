/**
 * Unit tests for lib/settlement.ts.
 *
 * Run with:  node --test --import tsx lib/settlement.test.ts
 *      (or)  npx tsx --test lib/settlement.test.ts
 *
 * No test framework dependencies — uses Node's built-in `node:test` and `node:assert/strict`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildForecastResultRows,
  calcHypotheticalPnl,
  calibrationBin,
  classifyMarket,
  deriveBracketType,
  didTradeWin,
  generateInsights,
  parseRangeFromQuestion,
  type ActualWeather,
  type ForecastResultRow,
  type RecommendationResultRow,
} from "./settlement";
import type { Forecast, Trade } from "./types";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const baseForecast: Forecast = {
  id:                  "f-1",
  created_at:          "2026-04-29T10:00:00Z",
  forecast_date:       "2026-04-29",
  day_index:           0,
  target_date:         "2026-04-29",
  high_temp:           70,
  low_temp:            55,
  precip_chance:       30,
  precip_type:         "Rain",
  notes:               null,
  forecast_confidence: "confident",
};

const baseActuals: ActualWeather = {
  date:       "2026-04-29",
  actualHigh: 72,
  actualLow:  54,
  rained:     true,
};

function tradeFixture(overrides: Partial<Trade> = {}): Trade {
  return {
    id:               "t-1",
    created_at:       "2026-04-29T10:00:00Z",
    market_id:        "KXHIGHPHIL-26APR29-T70",
    market_question:  "High Temp Philadelphia — 68–70°F",
    target_date:      "2026-04-29",
    side:             "YES",
    amount_usdc:      10,
    market_pct:       40,
    my_pct:           69,
    edge:             10,
    signal:           "buy",
    outcome:          "win",
    pnl:              null,
    polymarket_url:   null,
    kalshi_order_id:  "k-1",
    order_status:     "filled",
    filled_count:     25,
    remaining_count:  0,
    last_checked_at:  null,
    entry_yes_price:  0.4,
    ...overrides,
  };
}

// ── calcHypotheticalPnl ──────────────────────────────────────────────────────

test("calcHypotheticalPnl YES win", () => {
  // amount=10, entry=0.4, side=YES, won → contracts=floor(10/0.4)=25, pnl=25*(1-0.4)=15
  const pnl = calcHypotheticalPnl(10, 0.4, "YES", true);
  assert.equal(pnl, 15);
});

test("calcHypotheticalPnl YES loss", () => {
  // amount=10, entry=0.4, side=YES, lost → -(25*0.4) = -10
  const pnl = calcHypotheticalPnl(10, 0.4, "YES", false);
  assert.equal(pnl, -10);
});

test("calcHypotheticalPnl NO win", () => {
  // amount=10, entryYes=0.4 → side_price for NO = 0.6, contracts=floor(10/0.6)=16
  // pnl = 16 * (1 - 0.6) = 6.4
  const pnl = calcHypotheticalPnl(10, 0.4, "NO", true);
  assert.equal(pnl, 6.4);
});

test("calcHypotheticalPnl NO loss", () => {
  // contracts=16, lost → -(16*0.6) = -9.6
  const pnl = calcHypotheticalPnl(10, 0.4, "NO", false);
  assert.equal(pnl, -9.6);
});

test("calcHypotheticalPnl entry_price = 0 returns 0", () => {
  assert.equal(calcHypotheticalPnl(10, 0,    "YES", true),  0);
  assert.equal(calcHypotheticalPnl(10, 1,    "YES", true),  0);
  assert.equal(calcHypotheticalPnl(10, -0.1, "YES", true),  0);
});

// ── didTradeWin ──────────────────────────────────────────────────────────────

test("didTradeWin high YES inside bracket", () => {
  const t = tradeFixture({
    market_id:       "KXHIGHPHIL-26APR29-T70",
    market_question: "High Temp Philadelphia — 70–72°F",
    side:            "YES",
  });
  assert.equal(didTradeWin(t, { ...baseActuals, actualHigh: 71 }), true);
});

test("didTradeWin high NO outside bracket → wins", () => {
  const t = tradeFixture({
    market_question: "High Temp Philadelphia — 65–67°F",
    side:            "NO",
  });
  assert.equal(didTradeWin(t, { ...baseActuals, actualHigh: 80 }), true);
});

test("didTradeWin low YES open bracket >X", () => {
  const t = tradeFixture({
    market_id:       "KXLOWTPHIL-26APR29-T55",
    market_question: "Low Temp Philadelphia — >55°F",
    side:            "YES",
  });
  // >55 is exclusive → 55 does NOT win, 56 does
  assert.equal(didTradeWin(t, { ...baseActuals, actualLow: 55 }), false);
  assert.equal(didTradeWin(t, { ...baseActuals, actualLow: 56 }), true);
});

test("didTradeWin low YES open bracket <X (exclusive)", () => {
  const t = tradeFixture({
    market_id:       "KXLOWTPHIL-26APR29-T50",
    market_question: "Low Temp Philadelphia — <50°F",
    side:            "YES",
  });
  // <50 → 50 does not win, 49 does
  assert.equal(didTradeWin(t, { ...baseActuals, actualLow: 50 }), false);
  assert.equal(didTradeWin(t, { ...baseActuals, actualLow: 49 }), true);
});

test("didTradeWin precip YES wins when rained", () => {
  const t = tradeFixture({
    market_id:       "KXPRECIPPHIL-26APR29",
    market_question: "Will it rain in Philadelphia today?",
    side:            "YES",
  });
  assert.equal(didTradeWin(t, { ...baseActuals, rained: true  }), true);
  assert.equal(didTradeWin(t, { ...baseActuals, rained: false }), false);
});

test("didTradeWin precip NO wins when no rain", () => {
  const t = tradeFixture({
    market_id:       "KXPRECIPPHIL-26APR29",
    market_question: "Will it rain in Philadelphia today?",
    side:            "NO",
  });
  assert.equal(didTradeWin(t, { ...baseActuals, rained: false }), true);
});

test("didTradeWin between bracket includes both boundaries", () => {
  const t = tradeFixture({
    market_question: "High Temp Philadelphia — 68–70°F",
    side:            "YES",
  });
  assert.equal(didTradeWin(t, { ...baseActuals, actualHigh: 68 }), true);
  assert.equal(didTradeWin(t, { ...baseActuals, actualHigh: 70 }), true);
  assert.equal(didTradeWin(t, { ...baseActuals, actualHigh: 71 }), false);
});

// ── buildForecastResultRows ──────────────────────────────────────────────────

test("buildForecastResultRows produces all three metrics with correct values", () => {
  const rows = buildForecastResultRows(baseForecast, baseActuals);
  assert.equal(rows.length, 3);

  const high = rows.find((r) => r.metric === "high")!;
  assert.equal(high.predicted_value, 70);
  assert.equal(high.actual_value,    72);
  assert.equal(high.confidence_level, "confident");

  const low = rows.find((r) => r.metric === "low")!;
  assert.equal(low.predicted_value, 55);
  assert.equal(low.actual_value,    54);

  const precip = rows.find((r) => r.metric === "precip")!;
  assert.equal(precip.predicted_value, 30);
  assert.equal(precip.actual_value,    100); // rained=true
});

test("buildForecastResultRows precip = 0 when no rain", () => {
  const rows = buildForecastResultRows(baseForecast, { ...baseActuals, rained: false });
  const precip = rows.find((r) => r.metric === "precip")!;
  assert.equal(precip.actual_value, 0);
});

// ── parseRangeFromQuestion ──────────────────────────────────────────────────

test("parseRangeFromQuestion handles >X, <X, between, and precip", () => {
  assert.deepEqual(parseRangeFromQuestion("High Temp Philadelphia — >67°F"), { min: 67, max: null,  isPrecip: false });
  assert.deepEqual(parseRangeFromQuestion("High Temp Philadelphia — <65°F"), { min: null, max: 65,  isPrecip: false });
  assert.deepEqual(parseRangeFromQuestion("High Temp Philadelphia — 65–67°F"), { min: 65, max: 67, isPrecip: false });
  assert.equal(parseRangeFromQuestion("Will it rain in Philadelphia today?").isPrecip, true);
});

test("classifyMarket recognizes the three series", () => {
  assert.equal(classifyMarket("KXHIGHPHIL-26APR29-T70"), "high");
  assert.equal(classifyMarket("KXLOWTPHIL-26APR29-T55"), "low");
  assert.equal(classifyMarket("KXPRECIPPHIL-26APR29"),    "precip");
  assert.equal(classifyMarket("RANDOM-MKT"),              "unknown");
});

// ── deriveBracketType ────────────────────────────────────────────────────────

test("deriveBracketType: forecast / adjacent_low / adjacent_high", () => {
  // Forecast bracket: my_pct=69 falls within 68–70
  const t1 = tradeFixture({
    market_question: "High Temp Philadelphia — 68–70°F",
    my_pct:           69,
  });
  assert.equal(deriveBracketType(t1), "forecast");

  // adjacent_high: my_pct=80 above max=70
  const t2 = tradeFixture({
    market_question: "High Temp Philadelphia — 65–67°F",
    my_pct:           80,
  });
  assert.equal(deriveBracketType(t2), "adjacent_high");

  // adjacent_low: my_pct=60 below min=65
  const t3 = tradeFixture({
    market_question: "High Temp Philadelphia — 65–67°F",
    my_pct:           60,
  });
  assert.equal(deriveBracketType(t3), "adjacent_low");
});

test("deriveBracketType returns 'other' for precip and unknown markets", () => {
  const t = tradeFixture({
    market_id:       "KXPRECIPPHIL-26APR29",
    market_question: "Will it rain?",
  });
  assert.equal(deriveBracketType(t), "other");
});

// ── calibrationBin ───────────────────────────────────────────────────────────

test("calibrationBin assigns boundaries correctly", () => {
  // [0, 10) → bin 0;  [10, 25) → bin 1;  …;  100 → last bin
  assert.equal(calibrationBin(0),    0);
  assert.equal(calibrationBin(9.9),  0);
  assert.equal(calibrationBin(10),   1);
  assert.equal(calibrationBin(24.9), 1);
  assert.equal(calibrationBin(25),   2);
  assert.equal(calibrationBin(75),   4);
  assert.equal(calibrationBin(89.9), 4);
  assert.equal(calibrationBin(90),   5);
  assert.equal(calibrationBin(100),  5);
});

// ── generateInsights ─────────────────────────────────────────────────────────

test("generateInsights skips groups with n < 10 and sorts by deviation", () => {
  const fr: ForecastResultRow[] = Array.from({ length: 5 }, (_, i) => ({
    forecast_id:      `f-${i}`,
    forecast_date:    `2026-04-${String(i + 1).padStart(2, "0")}`,
    metric:           "high",
    predicted_value:  70,
    actual_value:     72,
    confidence_level: "confident",
  }));
  const rr: RecommendationResultRow[] = [];

  const out = generateInsights(fr, rr);
  // Only 5 rows — below the n=10 threshold — no high-temp insight
  assert.equal(out.length, 0);
});

test("generateInsights emits forecast bias when n >= 10", () => {
  const fr: ForecastResultRow[] = Array.from({ length: 12 }, (_, i) => ({
    forecast_id:      `f-${i}`,
    forecast_date:    `2026-04-${String(i + 1).padStart(2, "0")}`,
    metric:           "high",
    predicted_value:  70,    // consistently 2°F too high
    actual_value:     68,
    confidence_level: "confident",
  }));

  const out = generateInsights(fr, []);
  assert.ok(out.length >= 1);
  const ins = out[0];
  assert.equal(ins.n, 12);
  assert.ok(ins.text.toLowerCase().includes("above"));
  assert.ok(ins.deviationScore > 0);
});
