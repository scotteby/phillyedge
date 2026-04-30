/**
 * Unit tests for lib/rec-log.ts and the Phase 2.5 settlement extension
 * in lib/settlement.ts (settleRecommendationLog).
 *
 * Run with:  npx tsx --test lib/rec-log.test.ts
 *
 * No test framework dependencies — uses Node's built-in `node:test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveRecLogBracketType, linkTradeToRecommendation } from "./rec-log";
import { settleRecommendationLog } from "./settlement";
import type { BracketMarket } from "./brackets";

// ── deriveRecLogBracketType ──────────────────────────────────────────────────

function bracketFixture(overrides: Partial<BracketMarket> = {}): BracketMarket {
  return {
    market_id:  "KXHIGHPHIL-26APR29-T70",
    question:   "High Temp Philadelphia — 68–70°F",
    end_date:   "2026-04-29",
    yes_price:  0.4,
    yes_pct:    40,
    volume:     0,
    range:      { min: 68, max: 70, label: "68–70°" },
    relation:   "neutral",
    confidence: 50,
    edge:       10,
    signal:     "buy",
    trade_side: "YES",
    ...overrides,
  };
}

test("deriveRecLogBracketType: forecast / confirmed / likely_winner", () => {
  assert.equal(deriveRecLogBracketType(bracketFixture({ relation: "forecast" }), 69), "forecast");
  assert.equal(deriveRecLogBracketType(bracketFixture({ relation: "confirmed" }), 69), "forecast");
  assert.equal(deriveRecLogBracketType(bracketFixture({ relation: "likely_winner" }), 69), "forecast");
});

test("deriveRecLogBracketType: adjacent_low / adjacent_high / other", () => {
  // Bracket 65–67, forecast at 70 → bracket below forecast → adjacent_low
  const low = bracketFixture({
    relation: "adjacent",
    range:    { min: 65, max: 67, label: "65–67°" },
  });
  assert.equal(deriveRecLogBracketType(low, 70), "adjacent_low");

  // Bracket 72–74, forecast at 68 → bracket above forecast → adjacent_high
  const high = bracketFixture({
    relation: "adjacent",
    range:    { min: 72, max: 74, label: "72–74°" },
  });
  assert.equal(deriveRecLogBracketType(high, 68), "adjacent_high");

  // No forecast → other
  assert.equal(deriveRecLogBracketType(low, null), "other");

  // Open-ended bracket where no min/max criterion fires → other
  const openLow = bracketFixture({
    relation: "neutral",
    range:    { min: null, max: null, label: "?" },
  });
  assert.equal(deriveRecLogBracketType(openLow, 70), "other");
});

// ── linkTradeToRecommendation ────────────────────────────────────────────────
//
// We mock the Supabase client to verify the matcher chooses the right row:
//   - skips already-acted rows
//   - skips rows for other markets / target dates
//   - picks the most recent unacted row in window

interface FakeRow {
  id: string;
  market_id: string;
  target_date: string;
  acted_on: boolean;
  generated_at: string;
}

function makeFakeSupabase(rows: FakeRow[]) {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];

  function fromBuilder() {
    let filters: Array<(r: FakeRow) => boolean> = [];
    let orderDesc = true;
    let limitN = Infinity;

    const builder = {
      select() { return builder; },
      eq(col: string, val: unknown) {
        filters.push((r) => (r as unknown as Record<string, unknown>)[col] === val);
        return builder;
      },
      gt(col: string, val: string) {
        filters.push((r) => String((r as unknown as Record<string, unknown>)[col]) > val);
        return builder;
      },
      order(col: string, opts: { ascending: boolean }) {
        orderDesc = !opts.ascending;
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      then(resolve: (v: { data: FakeRow[]; error: null }) => unknown) {
        let result = rows.filter((r) => filters.every((f) => f(r)));
        result.sort((a, b) =>
          orderDesc
            ? b.generated_at.localeCompare(a.generated_at)
            : a.generated_at.localeCompare(b.generated_at),
        );
        result = result.slice(0, limitN);
        return Promise.resolve({ data: result, error: null }).then(resolve);
      },
      update(patch: Record<string, unknown>) {
        return {
          eq(col: string, val: unknown) {
            const target = rows.find(
              (r) => (r as unknown as Record<string, unknown>)[col] === val,
            );
            if (target) updates.push({ id: target.id, patch });
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
    };
    return builder;
  }

  return {
    client: { from: () => fromBuilder() } as unknown as Parameters<typeof linkTradeToRecommendation>[3],
    updates,
  };
}

test("linkTradeToRecommendation picks most recent unacted matching row", async () => {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const rows: FakeRow[] = [
    { id: "old",        market_id: "K1", target_date: "2026-04-29", acted_on: false, generated_at: iso(60_000 * 60 * 5) },   // 5h ago
    { id: "newest",     market_id: "K1", target_date: "2026-04-29", acted_on: false, generated_at: iso(60_000) },             // 1m ago
    { id: "already",    market_id: "K1", target_date: "2026-04-29", acted_on: true,  generated_at: iso(30_000) },             // ignored: already acted
    { id: "wrongMkt",   market_id: "K2", target_date: "2026-04-29", acted_on: false, generated_at: iso(10_000) },             // ignored: other market
    { id: "wrongDate",  market_id: "K1", target_date: "2026-04-28", acted_on: false, generated_at: iso(10_000) },             // ignored: other date
  ];

  const { client, updates } = makeFakeSupabase(rows);
  await linkTradeToRecommendation("trade-123", "K1", "2026-04-29", client);

  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, "newest");
  assert.equal(updates[0].patch.acted_on, true);
  assert.equal(updates[0].patch.trade_id, "trade-123");
});

test("linkTradeToRecommendation no-op when no matching row", async () => {
  const { client, updates } = makeFakeSupabase([]);
  await linkTradeToRecommendation("trade-1", "K1", "2026-04-29", client);
  assert.equal(updates.length, 0);
});

// ── Selection alpha math ─────────────────────────────────────────────────────
// Pure-math sanity check using the same formula the dashboard uses.

function selectionAlpha(rows: Array<{ acted: boolean; pnl: number }>) {
  const acted    = rows.filter((r) => r.acted);
  const notActed = rows.filter((r) => !r.acted);
  if (acted.length < 20 || notActed.length < 20) return null;
  const mean = (xs: typeof rows) => xs.reduce((s, r) => s + r.pnl, 0) / xs.length;
  return mean(acted) - mean(rows);
}

test("selection alpha: positive when picks beat the universe", () => {
  // 20 acted, all +$2.  20 not-acted, all -$1.  All-avg = +$0.50, picks-avg = +$2 → alpha = +$1.50
  const rows = [
    ...Array.from({ length: 20 }, () => ({ acted: true,  pnl: 2  })),
    ...Array.from({ length: 20 }, () => ({ acted: false, pnl: -1 })),
  ];
  const alpha = selectionAlpha(rows);
  assert.ok(alpha !== null);
  assert.equal(Number(alpha!.toFixed(2)), 1.5);
});

test("selection alpha: negative when picks underperform the universe", () => {
  const rows = [
    ...Array.from({ length: 20 }, () => ({ acted: true,  pnl: -1 })),
    ...Array.from({ length: 20 }, () => ({ acted: false, pnl: 2  })),
  ];
  const alpha = selectionAlpha(rows);
  assert.ok(alpha !== null);
  assert.equal(Number(alpha!.toFixed(2)), -1.5);
});

test("selection alpha: roughly neutral when picks match universe", () => {
  const rows = [
    ...Array.from({ length: 20 }, () => ({ acted: true,  pnl: 1 })),
    ...Array.from({ length: 20 }, () => ({ acted: false, pnl: 1 })),
  ];
  const alpha = selectionAlpha(rows);
  assert.equal(alpha, 0);
});

test("selection alpha: returns null when n < 20 in either bucket", () => {
  const rows = [
    ...Array.from({ length: 5  }, () => ({ acted: true,  pnl: 1 })),
    ...Array.from({ length: 50 }, () => ({ acted: false, pnl: 1 })),
  ];
  assert.equal(selectionAlpha(rows), null);
});

// ── settleRecommendationLog uses market_pct (not entry_yes_price) ────────────

test("settleRecommendationLog computes hypothetical_pnl_at_10 from market_pct", async () => {
  // YES side, market_pct=40 → entry=0.40, contracts=floor(10/0.4)=25.
  // High of 71 falls inside 70–72 → won → 25 * (1 - 0.4) = 15.
  const fakeRow = {
    id:              "rec-1",
    market_id:       "KXHIGHPHIL-26APR29-T70",
    market_question: "High Temp Philadelphia — 70–72°F",
    target_date:     "2026-04-29",
    side:            "YES" as const,
    market_pct:      40,
  };

  const updatesCaptured: Array<Record<string, unknown>> = [];

  const fakeClient = {
    from() {
      return {
        select() {
          return {
            eq() { return this; },
            // chain ends with two .eq()s — return the data on the final call
            // by exposing a then() once both filters applied.
            then: undefined as unknown,
          };
        },
      };
    },
  };

  // Build a more realistic chained mock specifically for settleRecommendationLog:
  const client = {
    from(_table: string) {
      let mode: "select" | "update" = "select";
      let updPatch: Record<string, unknown> | null = null;

      const handle = {
        select() { mode = "select"; return handle; },
        eq() { return handle; },
        update(patch: Record<string, unknown>) { mode = "update"; updPatch = patch; return handle; },
        then(resolve: (v: { data: unknown; error: null }) => unknown) {
          if (mode === "update") {
            updatesCaptured.push(updPatch!);
            return Promise.resolve({ data: null, error: null }).then(resolve);
          }
          return Promise.resolve({ data: [fakeRow], error: null }).then(resolve);
        },
      };
      return handle;
    },
  } as unknown as Parameters<typeof settleRecommendationLog>[2];

  const result = await settleRecommendationLog(
    "2026-04-29",
    { date: "2026-04-29", actualHigh: 71, actualLow: 60, rained: false },
    client,
  );

  assert.equal(result.errors.length, 0);
  assert.equal(result.settled, 1);
  assert.equal(updatesCaptured.length, 1);
  assert.equal(updatesCaptured[0].settled, true);
  assert.equal(updatesCaptured[0].would_have_won, true);
  assert.equal(updatesCaptured[0].hypothetical_pnl_at_10, 15);
});

// ── Dedup intent ─────────────────────────────────────────────────────────────
// We can't test the actual Postgres unique constraint here, but we can assert
// our shape: two rows with the same (market_id, target_date, signal, bracket_type)
// keys conflict, but the same row with a different signal does NOT.

test("dedup keys: same signal collides, different signal does not", () => {
  const k = (r: { market_id: string; target_date: string; signal: string; bracket_type: string }) =>
    `${r.market_id}|${r.target_date}|${r.signal}|${r.bracket_type}`;

  const a = { market_id: "K1", target_date: "2026-04-29", signal: "buy",       bracket_type: "forecast" };
  const b = { market_id: "K1", target_date: "2026-04-29", signal: "buy",       bracket_type: "forecast" };
  const c = { market_id: "K1", target_date: "2026-04-29", signal: "strong-buy",bracket_type: "forecast" };

  assert.equal(k(a), k(b));   // collide → ignoreDuplicates
  assert.notEqual(k(a), k(c));// new row inserted on signal upgrade
});
