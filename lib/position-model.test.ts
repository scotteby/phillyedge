/**
 * Unit tests for lib/position-model.ts
 *
 * Run with:  npx tsx --test lib/position-model.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPositions } from "./position-model";
import type { Trade } from "./types";

// ── Factory ───────────────────────────────────────────────────────────────────

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id:               "t1",
    created_at:       "2026-04-30T10:00:00Z",
    market_id:        "KXHIGHPHIL-26APR30-T65",
    market_question:  "High Temp Philadelphia — 65-66°",
    target_date:      "2026-04-30",
    side:             "YES",
    amount_usdc:      5.00,
    market_pct:       40,
    my_pct:           50,
    edge:             10,
    signal:           "buy",
    outcome:          "pending",
    pnl:              null,
    polymarket_url:   null,
    kalshi_order_id:  "ord-abc",
    order_status:     "filled",
    filled_count:     10,
    remaining_count:  0,
    last_checked_at:  null,
    entry_yes_price:  0.40,
    ...overrides,
  };
}

// ── Test 1: single buy → OPEN ─────────────────────────────────────────────────

test("single buy → OPEN", () => {
  const positions = buildPositions([makeTrade()]);
  assert.equal(positions.length, 1);
  const p = positions[0];
  assert.equal(p.state, "OPEN");
  assert.equal(p.contractsBought, 10);
  assert.equal(p.contractsSold, 0);
  assert.equal(p.netContracts, 10);
  assert.ok(Math.abs(p.avgBuyPrice - 0.40) < 0.001, `avgBuyPrice should be ~0.40, got ${p.avgBuyPrice}`);
  assert.equal(p.realizedPnl, 0);
  // ifCorrectPayout = 10 * (1 - 0.40) + 0 = 6.0
  assert.ok(Math.abs(p.ifCorrectPayout - 6.0) < 0.001, `ifCorrectPayout should be ~6.0, got ${p.ifCorrectPayout}`);
});

// ── Test 2: buy + buy → OPEN with weighted avg ────────────────────────────────

test("buy + buy → OPEN with weighted avg", () => {
  const t1 = makeTrade({ id: "t1", filled_count: 10, entry_yes_price: 0.40, created_at: "2026-04-30T10:00:00Z" });
  const t2 = makeTrade({ id: "t2", filled_count: 5,  entry_yes_price: 0.50, created_at: "2026-04-30T11:00:00Z" });
  const positions = buildPositions([t1, t2]);
  assert.equal(positions.length, 1);
  const p = positions[0];
  assert.equal(p.state, "OPEN");
  assert.equal(p.contractsBought, 15);
  // avgBuyPrice = (10*0.40 + 5*0.50) / 15 = (4 + 2.5) / 15 = 6.5/15
  const expected = 6.5 / 15;
  assert.ok(Math.abs(p.avgBuyPrice - expected) < 0.0001, `avgBuyPrice should be ~${expected.toFixed(4)}, got ${p.avgBuyPrice}`);
});

// ── Test 3: buy + sell (full) → CLOSED ───────────────────────────────────────

test("buy + sell (full) → CLOSED", () => {
  const buy  = makeTrade({ id: "t1", filled_count: 10, entry_yes_price: 0.40, outcome: "pending", pnl: null });
  const sell = makeTrade({ id: "t2", filled_count: 10, entry_yes_price: 0.40, outcome: "sold",    pnl: 1.00, created_at: "2026-04-30T11:00:00Z" });
  const positions = buildPositions([buy, sell]);
  assert.equal(positions.length, 1);
  const p = positions[0];
  assert.equal(p.state, "CLOSED");
  assert.equal(p.contractsSold, 10);
  assert.equal(p.netContracts, 0);
  assert.ok(Math.abs(p.realizedPnl - 1.00) < 0.001, `realizedPnl should be ~1.00, got ${p.realizedPnl}`);
  assert.ok(Math.abs(p.ifCorrectPayout - 1.00) < 0.001, `ifCorrectPayout should be ~1.00, got ${p.ifCorrectPayout}`);
});

// ── Test 4: buy + sell (partial) → PARTIALLY_CLOSED ─────────────────────────

test("buy + sell (partial) → PARTIALLY_CLOSED", () => {
  const buy  = makeTrade({ id: "t1", filled_count: 10, entry_yes_price: 0.40, outcome: "pending", pnl: null });
  const sell = makeTrade({ id: "t2", filled_count: 5,  entry_yes_price: 0.40, outcome: "sold",    pnl: 0.50, created_at: "2026-04-30T11:00:00Z" });
  const positions = buildPositions([buy, sell]);
  assert.equal(positions.length, 1);
  const p = positions[0];
  assert.equal(p.state, "PARTIALLY_CLOSED");
  assert.equal(p.netContracts, 5);
  assert.ok(Math.abs(p.realizedPnl - 0.50) < 0.001);
  // ifCorrectPayout = 5 * (1 - 0.40) + 0.50 = 3.0 + 0.50 = 3.50
  assert.ok(Math.abs(p.ifCorrectPayout - 3.50) < 0.001, `ifCorrectPayout should be ~3.50, got ${p.ifCorrectPayout}`);
});

// ── Test 5: multiple buys + multiple sells ───────────────────────────────────

test("multiple buys + multiple sells", () => {
  const b1   = makeTrade({ id: "t1", filled_count: 10, entry_yes_price: 0.40, outcome: "pending", pnl: null,  created_at: "2026-04-30T10:00:00Z" });
  const b2   = makeTrade({ id: "t2", filled_count: 5,  entry_yes_price: 0.50, outcome: "pending", pnl: null,  created_at: "2026-04-30T11:00:00Z" });
  const sell = makeTrade({ id: "t3", filled_count: 5,  entry_yes_price: 0.40, outcome: "sold",    pnl: 0.60,  created_at: "2026-04-30T12:00:00Z" });
  const positions = buildPositions([b1, b2, sell]);
  assert.equal(positions.length, 1);
  const p = positions[0];
  assert.equal(p.contractsBought, 15);
  assert.equal(p.contractsSold, 5);
  assert.equal(p.netContracts, 10);
  assert.equal(p.state, "PARTIALLY_CLOSED");
});

// ── Test 6: settled win → SETTLED ────────────────────────────────────────────

test("settled win → SETTLED", () => {
  const win = makeTrade({ id: "t1", filled_count: 10, entry_yes_price: 0.40, outcome: "win", pnl: 6.00 });
  const positions = buildPositions([win]);
  assert.equal(positions.length, 1);
  const p = positions[0];
  assert.equal(p.state, "SETTLED");
  assert.ok(Math.abs(p.realizedPnl - 6.00) < 0.001);
});

// ── Test 7: different sides → separate positions ─────────────────────────────

test("different sides → separate positions", () => {
  const yes = makeTrade({ id: "t1", side: "YES", filled_count: 10 });
  const no  = makeTrade({ id: "t2", side: "NO",  filled_count: 10 });
  const positions = buildPositions([yes, no]);
  assert.equal(positions.length, 2);
  const sides = positions.map((p) => p.side).sort();
  assert.deepEqual(sides, ["NO", "YES"]);
});

// ── Test 8: different markets → separate positions ───────────────────────────

test("different markets → separate positions", () => {
  const t1 = makeTrade({ id: "t1", market_id: "KXHIGHPHIL-26APR30-T65", filled_count: 10 });
  const t2 = makeTrade({ id: "t2", market_id: "KXHIGHPHIL-26APR30-T67", filled_count: 10 });
  const positions = buildPositions([t1, t2]);
  assert.equal(positions.length, 2);
});

// ── Test 9: resting order 0 fills → pendingOrders not fills ─────────────────

test("resting order 0 fills → pendingOrders not fills", () => {
  const resting = makeTrade({ id: "t1", order_status: "resting", filled_count: 0, outcome: "pending" });
  const positions = buildPositions([resting]);
  assert.equal(positions.length, 1);
  const p = positions[0];
  assert.equal(p.fills.length, 0);
  assert.equal(p.pendingOrders.length, 1);
  assert.equal(p.contractsBought, 0);
});

// ── Test 10: partially_filled trade contributes filled_count ─────────────────

test("partially_filled trade contributes filled_count", () => {
  const partial = makeTrade({ id: "t1", order_status: "partially_filled", filled_count: 4, remaining_count: 6, outcome: "pending" });
  const positions = buildPositions([partial]);
  assert.equal(positions.length, 1);
  const p = positions[0];
  assert.equal(p.fills.length, 1);
  assert.equal(p.contractsBought, 4);
});

// ── Test 11: contractsSold > contractsBought → netContracts clamps to 0 ─────

test("contractsSold > contractsBought → netContracts clamps to 0", () => {
  const buy  = makeTrade({ id: "t1", filled_count: 3,  outcome: "pending", pnl: null });
  const sell = makeTrade({ id: "t2", filled_count: 10, outcome: "sold",    pnl: 1.00, created_at: "2026-04-30T11:00:00Z" });
  // Should not throw
  const positions = buildPositions([buy, sell]);
  assert.equal(positions.length, 1);
  assert.equal(positions[0].netContracts, 0);
});
