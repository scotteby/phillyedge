/**
 * POST /api/boost-order
 *
 * "Boost" a resting, unfilled order by cancelling it and re-placing it
 * at a higher limit price to get fills faster.
 *
 * Body: { trade_id: string, new_price_cents: number }
 *
 * Steps:
 *   1. Look up the trade in Supabase
 *   2. Cancel the existing resting order on Kalshi
 *   3. Place a new limit buy order at new_price_cents
 *   4. Insert a new trade record in Supabase (the replacement)
 *   5. Mark the old trade as outcome="boosted", order_status="canceled"
 */

import { NextRequest, NextResponse } from "next/server";
import { buildKalshiAuthHeaders } from "@/lib/kalshi-sign";
import { createServiceClient } from "@/lib/supabase/server";
import { deriveTradeSignal } from "@/lib/signal";

const DEMO_MODE   = process.env.KALSHI_DEMO_MODE === "true";
const KALSHI_BASE = DEMO_MODE
  ? "https://demo-api.kalshi.co/trade-api/v2"
  : "https://api.elections.kalshi.com/trade-api/v2";
const ORDER_PATH  = "/trade-api/v2/portfolio/orders";

const SERIES_SLUGS: Record<string, string> = {
  kxhighphil:   "highest-temperature-in-philadelphia",
  kxlowtphil:   "lowest-temperature-in-philadelphia",
  kxprecipphil: "precipitation-in-philadelphia",
};

function kalshiUrl(ticker: string): string {
  const series = ticker.split("-")[0].toLowerCase();
  const slug   = SERIES_SLUGS[series] ?? series;
  return `https://kalshi.com/markets/${series}/${slug}/${ticker.toLowerCase()}`;
}

export async function POST(req: NextRequest) {
  let body: { trade_id: string; new_price_cents: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { trade_id, new_price_cents } = body;
  if (!trade_id || !new_price_cents) {
    return NextResponse.json({ error: "Missing trade_id or new_price_cents" }, { status: 400 });
  }
  if (new_price_cents < 1 || new_price_cents > 99) {
    return NextResponse.json({ error: "new_price_cents must be 1–99" }, { status: 400 });
  }

  const supabase = createServiceClient();

  // ── Look up old trade ─────────────────────────────────────────────────────
  const { data: trade, error: dbErr } = await supabase
    .from("trades")
    .select("id, market_id, market_question, target_date, side, amount_usdc, entry_yes_price, market_pct, my_pct, edge, signal, kalshi_order_id, order_status, filled_count, remaining_count, outcome, polymarket_url")
    .eq("id", trade_id)
    .single();

  if (dbErr || !trade) {
    return NextResponse.json({ error: "Trade not found" }, { status: 404 });
  }
  if (trade.outcome !== "pending") {
    return NextResponse.json({ error: "Trade is already settled" }, { status: 422 });
  }
  if (trade.order_status !== "resting" && trade.order_status !== "partially_filled") {
    return NextResponse.json({ error: "Order is not resting or partially filled — cannot boost" }, { status: 422 });
  }
  if (!trade.kalshi_order_id) {
    return NextResponse.json({ error: "No Kalshi order ID for this trade" }, { status: 422 });
  }

  const ticker    = trade.market_id as string;
  const side      = (trade.side as string).toLowerCase() as "yes" | "no";
  const orderId   = trade.kalshi_order_id as string;

  // Derive entry price and contract count
  const entryYes: number =
    (trade.entry_yes_price as number | null) ??
    (side === "yes"
      ? (trade.market_pct as number) / 100
      : 1 - (trade.market_pct as number) / 100);
  const entryCostPerContract = side === "yes" ? entryYes : 1 - entryYes;

  // Use > 0 check, not ??, because DB stores integer 0 before polling updates it
  const storedRemaining = trade.remaining_count as number | null;
  let count = storedRemaining != null && storedRemaining > 0
    ? storedRemaining
    : (entryCostPerContract > 0 ? Math.floor((trade.amount_usdc as number) / entryCostPerContract) : 0);

  // Last resort: fetch the live order from Kalshi to get contract count
  if (count < 1) {
    try {
      const orderPath = `/trade-api/v2/portfolio/orders/${orderId}`;
      const orderHeaders = buildKalshiAuthHeaders("GET", orderPath);
      const orderRes  = await fetch(`${KALSHI_BASE}/portfolio/orders/${orderId}`, { headers: orderHeaders });
      if (orderRes.ok) {
        const orderJson = await orderRes.json();
        const o         = (orderJson.order ?? orderJson) as Record<string, unknown>;
        const remaining = Number(o.remaining_count ?? 0);
        const original  = Number(o.count ?? o.original_count ?? 0);
        count = remaining > 0 ? remaining : original;
      }
    } catch {
      // swallow — we'll hit the guard below
    }
  }

  if (count < 1) {
    return NextResponse.json({ error: "Cannot determine contract count" }, { status: 422 });
  }

  // ── 1. Cancel the existing order on Kalshi ────────────────────────────────
  const cancelPath = `/trade-api/v2/portfolio/orders/${orderId}`;
  let cancelHeaders: Record<string, string>;
  try {
    cancelHeaders = buildKalshiAuthHeaders("DELETE", cancelPath);
  } catch (err) {
    return NextResponse.json({ error: `Signing error: ${String(err)}` }, { status: 500 });
  }

  try {
    const cancelRes = await fetch(`${KALSHI_BASE}/portfolio/orders/${orderId}`, {
      method: "DELETE",
      headers: cancelHeaders,
    });
    if (!cancelRes.ok) {
      const errBody = await cancelRes.json().catch(() => ({}));
      const msg = typeof errBody?.message === "string" ? errBody.message : JSON.stringify(errBody);
      console.error(`[boost-order] Cancel failed ${cancelRes.status}:`, JSON.stringify(errBody));
      return NextResponse.json({ error: `Kalshi cancel failed: ${msg}` }, { status: 502 });
    }
    console.log(`[boost-order] Cancelled order ${orderId}`);
  } catch (err) {
    return NextResponse.json({ error: `Cancel network error: ${String(err)}` }, { status: 502 });
  }

  // ── 2. Place new limit buy order at improved price ────────────────────────
  const newOrderBody: Record<string, unknown> = {
    ticker,
    action: "buy",
    side,
    type:  "limit",
    count,
    ...(side === "yes"
      ? { yes_price: new_price_cents }
      : { no_price:  new_price_cents }),
  };

  console.log("[boost-order] new order body:", JSON.stringify(newOrderBody));

  let placeHeaders: Record<string, string>;
  try {
    placeHeaders = buildKalshiAuthHeaders("POST", ORDER_PATH);
  } catch (err) {
    return NextResponse.json({ error: `Signing error: ${String(err)}` }, { status: 500 });
  }

  let newOrderId: string | null = null;
  try {
    const placeRes  = await fetch(`${KALSHI_BASE}/portfolio/orders`, {
      method: "POST",
      headers: placeHeaders,
      body:    JSON.stringify(newOrderBody),
    });
    const placeJson = await placeRes.json();
    if (!placeRes.ok) {
      console.error(`[boost-order] Place failed ${placeRes.status}:`, JSON.stringify(placeJson));
      const raw = placeJson?.message ?? placeJson?.error ?? placeJson;
      const msg = typeof raw === "string" ? raw : JSON.stringify(raw);
      // Cancel already happened — mark old trade as cancelled anyway
      await supabase
        .from("trades")
        .update({ outcome: "boosted", order_status: "canceled", last_checked_at: new Date().toISOString() })
        .eq("id", trade_id);
      return NextResponse.json({ error: `New order rejected: ${msg}` }, { status: 502 });
    }
    const placed = (placeJson?.order ?? placeJson) as Record<string, unknown>;
    newOrderId   = (placed.order_id as string | null) ?? null;
    console.log(`[boost-order] New order placed: ${newOrderId}`);
  } catch (err) {
    return NextResponse.json({ error: `Place network error: ${String(err)}` }, { status: 502 });
  }

  // ── 3. Persist to Supabase ────────────────────────────────────────────────
  const now             = new Date().toISOString();
  const newPriceDecimal = new_price_cents / 100;
  const newAmount       = count * newPriceDecimal;
  const newEntryYes     = side === "yes" ? newPriceDecimal : 1 - newPriceDecimal;
  const newMarketPct    = new_price_cents;  // same scale as original market_pct
  const newEdge         = ((trade.my_pct as number) ?? 50) - newMarketPct;
  const url             = (trade.polymarket_url as string | null) ?? kalshiUrl(ticker);

  // Insert replacement trade
  let newTradeId: string | null = null;
  try {
    const { data: inserted, error: insertErr } = await supabase
      .from("trades")
      .insert([{
        market_id:       ticker,
        market_question: trade.market_question,
        target_date:     trade.target_date,
        side:            (trade.side as string).toUpperCase(),
        amount_usdc:     newAmount,
        market_pct:      newMarketPct,
        my_pct:          trade.my_pct,
        edge:            newEdge,
        signal:          deriveTradeSignal(side.toUpperCase() as "YES" | "NO", newEdge),
        outcome:         "pending",
        pnl:             null,
        polymarket_url:  url,
        kalshi_order_id: newOrderId,
        order_status:    newOrderId ? "resting" : null,
        entry_yes_price: newEntryYes,
        filled_count:    0,
        remaining_count: count,
      }])
      .select("id")
      .single();

    if (insertErr) {
      console.error("[boost-order] Supabase insert error:", insertErr.message);
      // Return a 502 so the client knows the trade record is missing.
      // The Kalshi cancel + re-place already happened, so include the new_order_id
      // so the caller can recover (e.g. retry or display a warning).
      return NextResponse.json(
        {
          error:        `New order placed on Kalshi (${newOrderId}) but trade record failed to save: ${insertErr.message}`,
          new_order_id: newOrderId,
          ticker,
          side:         side.toUpperCase(),
          count,
          new_price_cents,
        },
        { status: 502 }
      );
    }
    newTradeId = (inserted as { id: string } | null)?.id ?? null;
  } catch (err) {
    console.error("[boost-order] Supabase insert threw:", err);
    return NextResponse.json(
      {
        error:        `New order placed on Kalshi (${newOrderId}) but trade record threw: ${String(err)}`,
        new_order_id: newOrderId,
        ticker,
        side:         side.toUpperCase(),
        count,
        new_price_cents,
      },
      { status: 502 }
    );
  }

  // Mark old trade as boosted
  const { error: boostDbErr } = await supabase
    .from("trades")
    .update({ outcome: "boosted", order_status: "canceled", last_checked_at: now })
    .eq("id", trade_id);

  if (boostDbErr) {
    console.error(`[boost-order] WARN: Supabase update failed for trade ${trade_id}:`, boostDbErr.message);
  }

  console.log(`[boost-order] ${ticker} boosted: old=${trade_id} new=${newTradeId} price=${new_price_cents}¢`);

  return NextResponse.json({
    ok:           true,
    old_trade_id: trade_id,
    new_trade_id: newTradeId,
    new_order_id: newOrderId,
    ticker,
    side:         side.toUpperCase(),
    count,
    new_price_cents,
    new_amount:   newAmount,
    new_edge:     newEdge,
  });
}
