import { NextRequest, NextResponse } from "next/server";
import { buildKalshiAuthHeaders } from "@/lib/kalshi-sign";
import { createServiceClient } from "@/lib/supabase/server";

const DEMO_MODE   = process.env.KALSHI_DEMO_MODE === "true";
const KALSHI_BASE = DEMO_MODE
  ? "https://demo-api.kalshi.co/trade-api/v2"
  : "https://api.elections.kalshi.com/trade-api/v2";

export async function POST(req: NextRequest) {
  let body: { trade_id: string };
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

  // Look up the trade
  const { data: trade, error: dbErr } = await supabase
    .from("trades")
    .select("id, kalshi_order_id, order_status, filled_count")
    .eq("id", trade_id)
    .single();

  if (dbErr || !trade) {
    return NextResponse.json({ error: "Trade not found" }, { status: 404 });
  }

  if (!trade.kalshi_order_id) {
    return NextResponse.json({ error: "No Kalshi order ID for this trade" }, { status: 422 });
  }

  const orderId = trade.kalshi_order_id as string;
  const apiPath = `/trade-api/v2/portfolio/orders/${orderId}`;

  // Sign the DELETE request
  let headers: Record<string, string>;
  try {
    headers = buildKalshiAuthHeaders("DELETE", apiPath);
  } catch (err) {
    return NextResponse.json(
      { error: `Signing error: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }

  // Send cancel to Kalshi
  try {
    const res = await fetch(`${KALSHI_BASE}/portfolio/orders/${orderId}`, {
      method: "DELETE",
      headers,
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const msg = typeof errBody?.message === "string"
        ? errBody.message
        : JSON.stringify(errBody);
      console.error(`[cancel-order] Kalshi ${res.status}:`, JSON.stringify(errBody));
      return NextResponse.json(
        { error: `Kalshi rejected cancel: ${msg}` },
        { status: 502 }
      );
    }
  } catch (err) {
    return NextResponse.json(
      { error: `Network error: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    );
  }

  // If this was a resting sell order (filled_count > 0 means the buy was already
  // filled and kalshi_order_id was swapped to the sell order), restore the trade
  // to "filled" so the position stays open.  For a regular pending buy order
  // (no fills yet), mark as "canceled" as before.
  const isSellOrder  = (trade.filled_count as number | null ?? 0) > 0;
  const restoredStatus = isSellOrder ? "filled" : "canceled";

  const now = new Date().toISOString();
  await supabase
    .from("trades")
    .update({ order_status: restoredStatus, last_checked_at: now })
    .eq("id", trade_id);

  return NextResponse.json({ ok: true, trade_id, order_status: restoredStatus, is_sell_order: isSellOrder });
}
