/**
 * POST /api/mark-sold
 *
 * Manually reconcile a trade that was sold on Kalshi but not recorded in the
 * DB (e.g. because the outcome constraint bug blocked the update).
 *
 * Body: { trade_id: string; sell_price_cents?: number }
 *   sell_price_cents — optional. If provided, P&L is computed from it.
 *                      If omitted, pnl is left null (can be updated later).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient }       from "@/lib/supabase/server";

export async function POST(req: NextRequest) {
  let body: { trade_id: string; sell_price_cents?: number };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid request body" }, { status: 400 }); }

  const { trade_id, sell_price_cents } = body;
  if (!trade_id) return NextResponse.json({ error: "Missing trade_id" }, { status: 400 });

  const supabase = createServiceClient();

  // Fetch the trade
  const { data: trade, error: fetchErr } = await supabase
    .from("trades")
    .select("id, side, filled_count, amount_usdc, entry_yes_price, market_pct, outcome")
    .eq("id", trade_id)
    .single();

  if (fetchErr || !trade) {
    return NextResponse.json({ error: "Trade not found" }, { status: 404 });
  }
  if (trade.outcome !== "pending") {
    return NextResponse.json({ error: `Trade is already ${trade.outcome}` }, { status: 422 });
  }

  // Compute P&L if sell price was provided
  let pnl: number | null = null;
  if (sell_price_cents != null) {
    const side            = (trade.side as string).toLowerCase() as "yes" | "no";
    const entryYesStored  = trade.entry_yes_price as number | null;
    const entryYes        = entryYesStored ?? (side === "yes"
      ? (trade.market_pct as number) / 100
      : 1 - (trade.market_pct as number) / 100);
    const entryCost       = side === "yes" ? entryYes : 1 - entryYes;

    const sellYesPrice    = sell_price_cents / 100;
    const sellProceeds    = side === "yes" ? sellYesPrice : 1 - sellYesPrice;

    const filled = (trade.filled_count as number | null) ?? 0;
    const contracts = filled > 0
      ? filled
      : entryCost > 0 ? Math.floor((trade.amount_usdc as number) / entryCost) : 0;

    if (contracts > 0) {
      pnl = parseFloat(((sellProceeds - entryCost) * contracts).toFixed(2));
    }
  }

  const { error: updateErr } = await supabase
    .from("trades")
    .update({ outcome: "sold", pnl, last_checked_at: new Date().toISOString() })
    .eq("id", trade_id);

  if (updateErr) {
    console.error("[mark-sold] DB update failed:", updateErr.message);
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  console.log(`[mark-sold] trade ${trade_id} marked sold, pnl=${pnl}`);
  return NextResponse.json({ ok: true, trade_id, pnl });
}
