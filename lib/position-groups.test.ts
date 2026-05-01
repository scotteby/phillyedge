/**
 * Unit tests for lib/position-groups.ts.
 *
 * Run with:  npx tsx --test lib/position-groups.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildPositionGroups,
  deployedAmountForTrade,
} from "./position-groups";
import type { Trade } from "./types";

// ── Fixtures ─────────────────────────────────────────────────────────────────

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
    edge:             12,
    signal:           "buy",
    outcome:          "pending",
    pnl:              null,
    polymarket_url:   null,
    kalshi_order_id:  "k-1",
    order_status:     "filled",
    filled_count:     25,
    remaining_count:  0,
    last_checked_at:  null,
    entry_yes_price:  0.40,
    ...overrides,
  };
}

// ── Test 1: Single-fill group ─────────────────────────────────────────────────

test("single-fill group returns 1 group with 1 trade", () => {
  const trade = tradeFixture();
  const groups = buildPositionGroups([trade]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].trades.length, 1);
});

// ── Test 2: Multi-fill group ──────────────────────────────────────────────────

test("two trades with same market_id + side collapse into 1 group", () => {
  const t1 = tradeFixture({ id: "t-1", amount_usdc: 6,  created_at: "2026-04-29T10:00:00Z" });
  const t2 = tradeFixture({ id: "t-2", amount_usdc: 4,  created_at: "2026-04-29T11:00:00Z" });
  const groups = buildPositionGroups([t1, t2]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].trades.length, 2);
  // Both are "filled" with known entry_yes_price, so deployedAmount = amount_usdc
  assert.equal(groups[0].totalAmount, 10);
});

// ── Test 3: Separate groups for different market_id ───────────────────────────

test("two trades with different market_id produce 2 groups", () => {
  const t1 = tradeFixture({ id: "t-1", market_id: "KXHIGHPHIL-26APR29-T70" });
  const t2 = tradeFixture({ id: "t-2", market_id: "KXHIGHPHIL-26APR29-T72" });
  const groups = buildPositionGroups([t1, t2]);
  assert.equal(groups.length, 2);
});

// ── Test 4: Different sides → separate groups ─────────────────────────────────

test("same market_id but different side produces 2 separate groups", () => {
  const t1 = tradeFixture({ id: "t-1", side: "YES" });
  const t2 = tradeFixture({ id: "t-2", side: "NO",  market_pct: 60, entry_yes_price: 0.40, edge: 10, signal: "buy" });
  const groups = buildPositionGroups([t1, t2]);
  assert.equal(groups.length, 2);
  const sides = groups.map((g) => g.side).sort();
  assert.deepEqual(sides, ["NO", "YES"]);
});

// ── Test 5: Weighted edge ─────────────────────────────────────────────────────

test("avgEdge is weighted by deployed amount", () => {
  // Trade A: amount=$6, edge=+12 (filled, so deployedAmount=6)
  // Trade B: amount=$4, edge=+18 (filled, so deployedAmount=4)
  // avgEdge = (6*12 + 4*18) / (6+4) = (72+72)/10 = 144/10 = 14.4
  const t1 = tradeFixture({ id: "t-1", amount_usdc: 6, edge: 12, created_at: "2026-04-29T10:00:00Z" });
  const t2 = tradeFixture({ id: "t-2", amount_usdc: 4, edge: 18, created_at: "2026-04-29T11:00:00Z" });
  const groups = buildPositionGroups([t1, t2]);
  assert.equal(groups[0].avgEdge, 14.4);
});

// ── Test 6: Mixed order status (filled + partially_filled) ────────────────────

test("filled + partially_filled → orderStatusSummary is partial", () => {
  const t1 = tradeFixture({ id: "t-1", order_status: "filled",           filled_count: 10 });
  const t2 = tradeFixture({ id: "t-2", order_status: "partially_filled", filled_count: 5, remaining_count: 5 });
  const groups = buildPositionGroups([t1, t2]);
  assert.equal(groups[0].orderStatusSummary, "partial");
});

// ── Test 7: totalPnl sum ──────────────────────────────────────────────────────

test("totalPnl sums non-null pnl values", () => {
  const t1 = tradeFixture({ id: "t-1", pnl: 1.20, outcome: "win" });
  const t2 = tradeFixture({ id: "t-2", pnl: 0.80, outcome: "win" });
  const groups = buildPositionGroups([t1, t2]);
  assert.equal(groups[0].totalPnl, 2.00);
});

// ── Test 8: totalPnl null propagation ────────────────────────────────────────

test("totalPnl counts non-null values even when one is null", () => {
  const t1 = tradeFixture({ id: "t-1", pnl: null,  outcome: "pending" });
  const t2 = tradeFixture({ id: "t-2", pnl: 1.00,  outcome: "win" });
  const groups = buildPositionGroups([t1, t2]);
  assert.equal(groups[0].totalPnl, 1.00);
});

// ── Test 9: deployedAmountForTrade with cancelled partial fill ────────────────

test("deployedAmountForTrade: cancelled order with 1 fill at 41¢ = 0.41", () => {
  const trade = tradeFixture({
    order_status:    "canceled",
    filled_count:    1,
    remaining_count: 0,
    amount_usdc:     10,
    entry_yes_price: 0.41,
  });
  // isPartial: 1 * 0.41 = 0.41, which < 10 - 0.01 = 9.99 → isPartial = true
  // deployed = 1 * 0.41 = 0.41
  const deployed = deployedAmountForTrade(trade);
  assert.ok(Math.abs(deployed - 0.41) < 0.0001, `expected ~0.41, got ${deployed}`);
});

// ── Test 10: edgesVary ────────────────────────────────────────────────────────

test("edgesVary is false when all edges are the same", () => {
  const t1 = tradeFixture({ id: "t-1", edge: 12 });
  const t2 = tradeFixture({ id: "t-2", edge: 12 });
  const groups = buildPositionGroups([t1, t2]);
  assert.equal(groups[0].edgesVary, false);
});

test("edgesVary is true when edges differ", () => {
  const t1 = tradeFixture({ id: "t-1", edge: 12 });
  const t2 = tradeFixture({ id: "t-2", edge: 18 });
  const groups = buildPositionGroups([t1, t2]);
  assert.equal(groups[0].edgesVary, true);
});
