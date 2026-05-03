/**
 * POST /api/reconcile-fills
 *
 * Back-fills pnl for "sold" trades that have pnl=null (or pnl=0 when
 * P&L clearly should not be zero) by fetching actual fill prices from
 * Kalshi's /portfolio/fills endpoint.
 *
 * Also returns debug info so the browser console shows exactly what was found.
 */

import { NextResponse } from "next/server";
import { buildKalshiAuthHeaders } from "@/lib/kalshi-sign";
import { createServiceClient } from "@/lib/supabase/server";

const DEMO_MODE   = process.env.KALSHI_DEMO_MODE === "true";
const KALSHI_BASE = DEMO_MODE
  ? "https://demo-api.kalshi.co/trade-api/v2"
  : "https://api.elections.kalshi.com/trade-api/v2";

// ── Fetch helpers ──────────────────────────────────────────────────────────────

async function kalshiGet(path: string): Promise<{ ok: boolean; json: unknown; status: number }> {
  let headers: Record<string, string>;
  try {
    headers = buildKalshiAuthHeaders("GET", path);
  } catch (err) {
    return { ok: false, json: { error: String(err) }, status: 500 };
  }
  const res = await fetch(`${KALSHI_BASE}${path.replace("/trade-api/v2", "")}`, {
    method: "GET", headers, cache: "no-store",
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, json, status: res.status };
}

/** Parse YES price (0–1 decimal) from any Kalshi price field. */
function toYesPrice(raw: unknown, side: string): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  if (isNaN(n) || n <= 0) return null;
  // Kalshi may return integer cents (e.g. 6) or decimal (e.g. 0.06)
  const yesPrice = n > 1 ? n / 100 : n;
  // For NO orders, Kalshi returns the NO price; convert to YES price.
  return side.toLowerCase() === "no" ? 1 - yesPrice : yesPrice;
}

/** Parse count from fill_count_fp (string) or plain count field. */
function toCount(fill: Record<string, unknown>): number {
  const fp = fill.fill_count_fp ?? fill.count_fp ?? fill.count;
  const n  = parseFloat(String(fp ?? "0"));
  return isNaN(n) ? 0 : n;
}

export async function POST() {
  const supabase = createServiceClient();

  // ── 1. Load sold trades that need pnl back-filled ────────────────────────────
  // A trade needs reconciliation when:
  //   - outcome = "sold" AND pnl IS NULL
  //   - outcome = "sold" AND pnl = 0 (can only happen if avgFill = entryCost exactly — very rare)
  const { data: rawTrades, error: dbErr } = await supabase
    .from("trades")
    .select("id, market_id, side, entry_yes_price, market_pct, kalshi_order_id, outcome, amount_usdc, filled_count, pnl")
    .eq("outcome", "sold");

  if (dbErr) {
    return NextResponse.json({ error: `DB error: ${dbErr.message}` }, { status: 500 });
  }

  type DbTrade = {
    id: string; market_id: string; side: string;
    entry_yes_price: number | null; market_pct: number;
    kalshi_order_id: string | null; outcome: string;
    amount_usdc: number; filled_count: number | null; pnl: number | null;
  };

  const soldTrades = (rawTrades ?? []) as DbTrade[];
  // Only reconcile trades where pnl is null (zero is valid — market at fair value)
  const needsReconcile = soldTrades.filter((t) => t.pnl === null);

  console.log(`[reconcile] ${soldTrades.length} sold trades total, ${needsReconcile.length} with pnl=null`);

  if (needsReconcile.length === 0) {
    return NextResponse.json({
      ok: true,
      pnl_fixed: 0,
      sold_trades_total: soldTrades.length,
      needs_reconcile: 0,
      message: "All sold trades already have pnl recorded.",
    });
  }

  // ── 2. Fetch fills from Kalshi ────────────────────────────────────────────────
  // Paginate to get all fills (Kalshi max 1000 per request)
  const allFills: Record<string, unknown>[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < 10; page++) {
    const qs     = new URLSearchParams({ limit: "200" });
    if (cursor) qs.set("cursor", cursor);
    const result = await kalshiGet(`/trade-api/v2/portfolio/fills?${qs.toString()}`);

    if (!result.ok) {
      console.error("[reconcile] fills API error:", result.status, JSON.stringify(result.json));
      // Don't bail — fall through to orders-based reconcile below
      break;
    }

    const body   = result.json as Record<string, unknown>;
    // Kalshi may wrap fills as "fills" or "fill_events" depending on version
    const page_fills = (body.fills ?? body.fill_events ?? []) as Record<string, unknown>[];
    allFills.push(...page_fills);

    const nextCursor = body.cursor as string | undefined;
    console.log(`[reconcile] fills page ${page + 1}: ${page_fills.length} fills, cursor=${nextCursor}`);
    if (!nextCursor || page_fills.length === 0) break;
    cursor = nextCursor;
  }

  console.log(`[reconcile] ${allFills.length} total fills fetched`);
  if (allFills.length > 0) {
    console.log("[reconcile] first fill sample:", JSON.stringify(allFills[0]));
  }

  // ── 3. Also fetch all portfolio orders (sell only) as a fallback ─────────────
  // The orders API is well-tested and includes avg_yes_price / avg_fill_price.
  const allSellOrders: Record<string, unknown>[] = [];
  let orderCursor: string | undefined;

  for (let page = 0; page < 10; page++) {
    const qs = new URLSearchParams({ limit: "200", action: "sell" });
    if (orderCursor) qs.set("cursor", orderCursor);
    const result = await kalshiGet(`/trade-api/v2/portfolio/orders?${qs.toString()}`);

    if (!result.ok) {
      console.error("[reconcile] orders API error:", result.status);
      break;
    }
    const body       = result.json as Record<string, unknown>;
    const page_orders = (body.orders ?? []) as Record<string, unknown>[];
    allSellOrders.push(...page_orders);

    const nextCursor = body.cursor as string | undefined;
    console.log(`[reconcile] sell orders page ${page + 1}: ${page_orders.length} orders, cursor=${nextCursor}`);
    if (!nextCursor || page_orders.length === 0) break;
    orderCursor = nextCursor;
  }

  console.log(`[reconcile] ${allSellOrders.length} total sell orders fetched`);

  // ── 4. Build lookup indexes ──────────────────────────────────────────────────

  // Fills indexed by order_id and by (ticker/market_id + side)
  const fillsByOrderId   = new Map<string, Record<string, unknown>[]>();
  const fillsByTickerSide = new Map<string, Record<string, unknown>[]>();

  for (const f of allFills) {
    const orderId    = String(f.order_id   ?? "");
    const ticker     = String(f.ticker ?? f.market_id ?? "").toUpperCase();
    const side       = String(f.side   ?? "").toLowerCase();
    const action     = String(f.action ?? "").toLowerCase();
    if (action !== "sell" && action !== "") continue; // only sell fills interest us

    if (orderId) {
      const arr = fillsByOrderId.get(orderId) ?? [];
      arr.push(f);
      fillsByOrderId.set(orderId, arr);
    }
    if (ticker && side) {
      const key = `${ticker}__${side}`;
      const arr = fillsByTickerSide.get(key) ?? [];
      arr.push(f);
      fillsByTickerSide.set(key, arr);
    }
  }

  // Sell orders indexed by order_id and by (ticker + side)
  const ordersByOrderId    = new Map<string, Record<string, unknown>>();
  const ordersByTickerSide = new Map<string, Record<string, unknown>[]>();

  for (const o of allSellOrders) {
    const orderId = String(o.order_id ?? "");
    const ticker  = String(o.ticker ?? o.market_id ?? "").toUpperCase();
    const side    = String(o.side   ?? "").toLowerCase();
    const status  = String(o.status ?? "").toLowerCase();
    // Only use fully-filled sell orders for pnl calc
    if (status !== "filled" && status !== "executed") continue;

    if (orderId) ordersByOrderId.set(orderId, o);
    if (ticker && side) {
      const key = `${ticker}__${side}`;
      const arr = ordersByTickerSide.get(key) ?? [];
      arr.push(o);
      ordersByTickerSide.set(key, arr);
    }
  }

  // ── 5. Compute avg YES fill price per trade ──────────────────────────────────

  function getAvgYesPriceFromFills(
    fills: Record<string, unknown>[],
    side: string,
  ): number | null {
    let totalW = 0, totalC = 0;
    for (const f of fills) {
      const c   = toCount(f);
      // Fills may store YES price or side-specific price
      const yp  =
        toYesPrice(f.yes_price, "yes")  ??
        toYesPrice(f.no_price,  "no")   ??
        toYesPrice(f.price,     side);
      if (c > 0 && yp != null) { totalW += c * yp; totalC += c; }
    }
    return totalC > 0 ? totalW / totalC : null;
  }

  function getAvgYesPriceFromOrder(order: Record<string, unknown>, side: string): number | null {
    // avg_yes_price is the definitive field when available
    return (
      toYesPrice(order.avg_yes_price,  "yes") ??
      toYesPrice(order.avg_fill_price, side)  ??
      toYesPrice(order.yes_price,      "yes") ??
      null
    );
  }

  // ── 6. Match and update each trade ──────────────────────────────────────────
  let pnlFixed  = 0;
  const debugRows: unknown[] = [];

  for (const trade of needsReconcile) {
    const tradeSide = trade.side.toLowerCase() as "yes" | "no";
    const tickerKey = `${trade.market_id.toUpperCase()}__${tradeSide}`;

    const entryYes: number =
      trade.entry_yes_price ??
      (tradeSide === "yes" ? trade.market_pct / 100 : 1 - trade.market_pct / 100);
    const entryCost = tradeSide === "yes" ? entryYes : 1 - entryYes;
    const filledCount = trade.filled_count ??
      (entryCost > 0 ? Math.floor(trade.amount_usdc / entryCost) : 0);

    if (filledCount <= 0) {
      debugRows.push({ id: trade.id, market_id: trade.market_id, reason: "no filled contracts" });
      continue;
    }

    let avgFillYes: number | null = null;
    let matchSource = "none";

    // Try 1: fill matched by kalshi_order_id (works when sell order ID was stored)
    if (trade.kalshi_order_id) {
      const orderFills = fillsByOrderId.get(trade.kalshi_order_id);
      if (orderFills?.length) {
        avgFillYes  = getAvgYesPriceFromFills(orderFills, tradeSide);
        matchSource = "fill.order_id";
      }
    }

    // Try 2: sell order matched by order_id
    if (avgFillYes == null && trade.kalshi_order_id) {
      const order = ordersByOrderId.get(trade.kalshi_order_id);
      if (order) {
        avgFillYes  = getAvgYesPriceFromOrder(order, tradeSide);
        matchSource = "order.order_id";
      }
    }

    // Try 3: fill matched by ticker + side (all fills for this market/side)
    if (avgFillYes == null) {
      const tFills = fillsByTickerSide.get(tickerKey) ?? [];
      if (tFills.length) {
        avgFillYes  = getAvgYesPriceFromFills(tFills, tradeSide);
        matchSource = "fill.ticker+side";
      }
    }

    // Try 4: sell order matched by ticker + side
    if (avgFillYes == null) {
      const orders = ordersByTickerSide.get(tickerKey) ?? [];
      if (orders.length) {
        // Prefer the order whose quantity_matched ≈ our filledCount
        const best = orders.find((o) => {
          const qm = parseFloat(String(o.quantity_matched ?? o.fill_count_fp ?? "0"));
          return Math.abs(qm - filledCount) < 2;
        }) ?? orders[0];
        avgFillYes  = getAvgYesPriceFromOrder(best, tradeSide);
        matchSource = "order.ticker+side";
      }
    }

    const proceedsPerContract = avgFillYes != null
      ? (tradeSide === "yes" ? avgFillYes : 1 - avgFillYes)
      : null;
    const pnl = proceedsPerContract != null
      ? parseFloat(((proceedsPerContract - entryCost) * filledCount).toFixed(2))
      : null;

    debugRows.push({
      id: trade.id, market_id: trade.market_id, side: tradeSide,
      filledCount, entryCost: entryCost.toFixed(4),
      avgFillYes: avgFillYes?.toFixed(4) ?? null,
      pnl, matchSource,
    });

    if (pnl != null) {
      const { error: updateErr } = await supabase
        .from("trades")
        .update({ pnl })
        .eq("id", trade.id);
      if (!updateErr) {
        pnlFixed++;
        console.log(`[reconcile] ✅ trade ${trade.id} (${trade.market_id} ${tradeSide}): pnl=${pnl} via ${matchSource}`);
      } else {
        console.error(`[reconcile] ❌ DB update failed for ${trade.id}:`, updateErr.message);
      }
    } else {
      console.log(`[reconcile] ❌ no price found for ${trade.id} (${trade.market_id} ${tradeSide}) via ${matchSource}`);
    }
  }

  return NextResponse.json({
    ok:                true,
    pnl_fixed:         pnlFixed,
    sold_trades_total: soldTrades.length,
    needs_reconcile:   needsReconcile.length,
    fills_fetched:     allFills.length,
    sell_orders_fetched: allSellOrders.length,
    debug:             debugRows,
    first_fill_sample: allFills[0] ?? null,
    first_order_sample: allSellOrders[0] ?? null,
  });
}
