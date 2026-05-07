/**
 * POST /api/simulate-fill
 *
 * Demo-only: marks a resting demo order as filled in Supabase without
 * requiring actual Kalshi exchange activity. Used when the demo exchange
 * has no counterparty liquidity for a bracket.
 *
 * Body: { trade_id: string }
 *
 * - Only works on trades with demo = true and order_status = "resting"
 * - Calculates filled_count from amount_usdc / entry_yes_price
 * - Sets order_status = "filled", filled_count = N
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

export async function POST(req: NextRequest) {
  let body: { trade_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { trade_id } = body;
  if (!trade_id) {
    return NextResponse.json({ error: "Missing trade_id" }, { status: 400 });
  }

  const supabase = createServiceClient();

  const { data: trade, error: dbErr } = await supabase
    .from("trades")
    .select("id, demo, order_status, outcome, amount_usdc, entry_yes_price, market_pct, side, filled_count")
    .eq("id", trade_id)
    .single();

  if (dbErr || !trade) {
    return NextResponse.json({ error: "Trade not found" }, { status: 404 });
  }
  if (!trade.demo) {
    return NextResponse.json({ error: "simulate-fill is only available for demo trades" }, { status: 422 });
  }
  if (trade.outcome !== "pending") {
    return NextResponse.json({ error: "Trade is already settled" }, { status: 422 });
  }
  if (trade.order_status !== "resting" && trade.order_status !== "partially_filled") {
    return NextResponse.json({ error: "Order is not resting — nothing to fill" }, { status: 422 });
  }

  // Derive fill count from amount and price
  const entryYes: number =
    (trade.entry_yes_price as number | null) ??
    ((trade.side as string).toLowerCase() === "yes"
      ? (trade.market_pct as number) / 100
      : 1 - (trade.market_pct as number) / 100);

  const entryPrice = (trade.side as string).toLowerCase() === "yes" ? entryYes : 1 - entryYes;
  const alreadyFilled = (trade.filled_count as number | null) ?? 0;
  const totalFilled = entryPrice > 0
    ? Math.max(alreadyFilled, Math.round((trade.amount_usdc as number) / entryPrice))
    : alreadyFilled;

  const now = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from("trades")
    .update({
      order_status:    "filled",
      filled_count:    totalFilled,
      last_checked_at: now,
    })
    .eq("id", trade_id);

  if (updateErr) {
    return NextResponse.json({ error: `DB update failed: ${updateErr.message}` }, { status: 500 });
  }

  console.log(`[simulate-fill] Demo trade ${trade_id} marked as filled (${totalFilled} contracts)`);

  return NextResponse.json({
    ok:           true,
    trade_id,
    filled_count: totalFilled,
    order_status: "filled",
  });
}
