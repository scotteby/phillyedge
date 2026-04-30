/**
 * POST /api/recover-order
 *
 * Given a Kalshi order ID, fetches the order from Kalshi and inserts a
 * trade record in Supabase.  Used to recover missing trades when a boost
 * succeeded on Kalshi but the DB insert failed.
 *
 * Body: { kalshi_order_id: string, my_pct?: number }
 */

import { NextRequest, NextResponse } from "next/server";
import { buildKalshiAuthHeaders } from "@/lib/kalshi-sign";
import { createServiceClient } from "@/lib/supabase/server";
import { deriveTradeSignal } from "@/lib/signal";

const DEMO_MODE   = process.env.KALSHI_DEMO_MODE === "true";
const KALSHI_BASE = DEMO_MODE
  ? "https://demo-api.kalshi.co/trade-api/v2"
  : "https://api.elections.kalshi.com/trade-api/v2";

export async function POST(req: NextRequest) {
  let body: { kalshi_order_id: string; my_pct?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { kalshi_order_id, my_pct } = body;
  if (!kalshi_order_id) {
    return NextResponse.json({ error: "Missing kalshi_order_id" }, { status: 400 });
  }

  const supabase = createServiceClient();

  // Check if a trade already exists for this order ID
  const { data: existing } = await supabase
    .from("trades")
    .select("id")
    .eq("kalshi_order_id", kalshi_order_id)
    .single();

  if (existing) {
    return NextResponse.json({ ok: true, trade_id: existing.id, already_exists: true });
  }

  // Fetch the order from Kalshi
  const apiPath = `/trade-api/v2/portfolio/orders/${kalshi_order_id}`;
  let headers: Record<string, string>;
  try {
    headers = buildKalshiAuthHeaders("GET", apiPath);
  } catch (err) {
    return NextResponse.json({ error: `Signing error: ${String(err)}` }, { status: 500 });
  }

  let order: Record<string, unknown>;
  try {
    const res = await fetch(`${KALSHI_BASE}/portfolio/orders/${kalshi_order_id}`, {
      method: "GET",
      headers,
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return NextResponse.json({ error: `Kalshi ${res.status}: ${JSON.stringify(body)}` }, { status: 502 });
    }
    const json = await res.json();
    order = (json.order ?? json) as Record<string, unknown>;
  } catch (err) {
    return NextResponse.json({ error: `Network error: ${String(err)}` }, { status: 502 });
  }

  console.log("[recover-order] Kalshi order:", JSON.stringify(order));

  const ticker   = String(order.ticker ?? "");
  const side     = String(order.side   ?? "yes").toLowerCase() as "yes" | "no";
  const rawStatus = String(order.status ?? "resting");
  const count    = parseFloat(String(order.initial_count_fp ?? order.count ?? 0));
  const remaining = parseFloat(String(order.remaining_count_fp ?? order.remaining_count ?? 0));
  const filled   = parseFloat(String(order.fill_count_fp ?? order.filled_count ?? 0));

  const yesPriceCents = parseFloat(String(order.yes_price ?? order.yes_price_dollars ?? 0));
  const noPriceCents  = parseFloat(String(order.no_price  ?? order.no_price_dollars  ?? 0));

  // Determine entry_yes_price (0–1 scale)
  const entryYes = side === "yes"
    ? yesPriceCents / (yesPriceCents > 1 ? 100 : 1)  // already 0–1 or cents
    : 1 - noPriceCents / (noPriceCents > 1 ? 100 : 1);

  const marketPct = side === "yes"
    ? Math.round(yesPriceCents > 1 ? yesPriceCents : yesPriceCents * 100)
    : Math.round(noPriceCents  > 1 ? noPriceCents  : noPriceCents  * 100);

  const myPct  = my_pct ?? 50;
  const edge   = myPct - marketPct;
  const signal = deriveTradeSignal(side.toUpperCase() as "YES" | "NO", edge);

  // Map Kalshi status
  const orderStatus = (rawStatus === "executed" || rawStatus === "filled") ? "filled"
    : rawStatus === "resting" ? "resting"
    : rawStatus === "partially_filled" ? "partially_filled"
    : (rawStatus === "canceled" || rawStatus === "cancelled" || rawStatus === "fok_canceled") ? "canceled"
    : "resting";

  // Fetch market details to get question + target_date
  let marketQuestion = ticker;
  let targetDate: string | null = null;
  try {
    const mktRes = await fetch(
      `${KALSHI_BASE}/markets/${encodeURIComponent(ticker)}`,
      { headers: { Accept: "application/json" }, cache: "no-store" }
    );
    if (mktRes.ok) {
      const mktJson = await mktRes.json();
      const mkt = (mktJson.market ?? mktJson) as Record<string, unknown>;
      marketQuestion = String(mkt.title ?? mkt.subtitle ?? ticker);
      targetDate = String(mkt.close_time ?? mkt.expiration_time ?? "").slice(0, 10) || null;
    }
  } catch {
    // Non-fatal
  }

  const amount = count * (side === "yes" ? entryYes : 1 - entryYes);

  const { data: inserted, error: insertErr } = await supabase
    .from("trades")
    .insert([{
      market_id:       ticker,
      market_question: marketQuestion,
      target_date:     targetDate,
      side:            side.toUpperCase(),
      amount_usdc:     amount,
      market_pct:      marketPct,
      my_pct:          myPct,
      edge,
      signal,
      outcome:         "pending",
      pnl:             null,
      kalshi_order_id: kalshi_order_id,
      order_status:    orderStatus,
      entry_yes_price: entryYes,
      filled_count:    Math.round(filled),
      remaining_count: Math.round(remaining),
    }])
    .select("id")
    .single();

  if (insertErr) {
    console.error("[recover-order] Insert failed:", insertErr.message);
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  const tradeId = (inserted as { id: string }).id;
  console.log(`[recover-order] Recovered trade ${tradeId} for Kalshi order ${kalshi_order_id}`);

  return NextResponse.json({
    ok:            true,
    trade_id:      tradeId,
    kalshi_order_id,
    ticker,
    side:          side.toUpperCase(),
    order_status:  orderStatus,
    market_pct:    marketPct,
    entry_yes_price: entryYes,
    count,
  });
}
