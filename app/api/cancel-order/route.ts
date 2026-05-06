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
    .select("id, kalshi_order_id, order_status, filled_count, remaining_count")
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

  // Send cancel to Kalshi. A 404 means the order is already gone (already cancelled,
  // expired, or filled) — treat that as a success so we can still clean up the DB.
  try {
    const res = await fetch(`${KALSHI_BASE}/portfolio/orders/${orderId}`, {
      method: "DELETE",
      headers,
    });

    if (!res.ok && res.status !== 404) {
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

    if (res.status === 404) {
      console.log(`[cancel-order] Order ${orderId} already gone on Kalshi — cleaning up DB only`);
    }
  } catch (err) {
    return NextResponse.json(
      { error: `Network error: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    );
  }

  // Detect sell order by the remaining_count=-1 sentinel (most reliable) or
  // filled_count > 0 as a fallback (covers older records before the sentinel).
  const isSellOrder = (trade.remaining_count as number | null) === -1
    || (trade.filled_count as number | null ?? 0) > 0;

  // For a resting sell order: restore the trade to "pending/filled" state so the
  // open position becomes visible again with a Sell button.
  // For a plain buy order with no fills: mark as canceled.
  const restoredStatus = isSellOrder ? "filled" : "canceled";

  const now = new Date().toISOString();
  const dbUpdate: Record<string, unknown> = {
    order_status:    restoredStatus,
    last_checked_at: now,
  };

  if (isSellOrder) {
    // Clear the sell-order sentinel and the stale sell order ID so the
    // order-status poller doesn't accidentally zero out filled_count.
    dbUpdate.kalshi_order_id = null;
    dbUpdate.remaining_count = null;   // clear -1 sentinel; position is open again
  }

  await supabase
    .from("trades")
    .update(dbUpdate)
    .eq("id", trade_id);

  return NextResponse.json({ ok: true, trade_id, order_status: restoredStatus, is_sell_order: isSellOrder });
}
