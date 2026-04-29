import { NextRequest, NextResponse } from "next/server";
import { buildKalshiAuthHeaders } from "@/lib/kalshi-sign";
import { createServiceClient } from "@/lib/supabase/server";
import type { OrderStatus } from "@/lib/types";

const DEMO_MODE   = process.env.KALSHI_DEMO_MODE === "true";
const KALSHI_BASE = DEMO_MODE
  ? "https://demo-api.kalshi.co/trade-api/v2"
  : "https://api.elections.kalshi.com/trade-api/v2";

/** Map Kalshi order statuses to our internal set. */
function normaliseStatus(raw: string): OrderStatus {
  switch (raw) {
    case "resting":           return "resting";
    case "partially_filled":  return "partially_filled";
    case "executed":          return "filled";
    case "filled":            return "filled";
    case "canceled":          return "canceled";
    case "cancelled":         return "canceled";
    case "expired":           return "expired";
    case "fok_canceled":      return "canceled";
    default:                  return "resting"; // treat unknown as resting
  }
}

export async function GET(req: NextRequest) {
  const tradeId = req.nextUrl.searchParams.get("trade_id");
  if (!tradeId) {
    return NextResponse.json({ error: "Missing trade_id query param" }, { status: 400 });
  }

  const supabase = createServiceClient();

  // Look up the trade to get kalshi_order_id
  const { data: trade, error: dbErr } = await supabase
    .from("trades")
    .select("id, kalshi_order_id, order_status")
    .eq("id", tradeId)
    .single();

  if (dbErr || !trade) {
    return NextResponse.json({ error: "Trade not found" }, { status: 404 });
  }

  if (!trade.kalshi_order_id) {
    return NextResponse.json({ error: "No Kalshi order ID for this trade" }, { status: 422 });
  }

  const orderId  = trade.kalshi_order_id as string;
  const apiPath  = `/trade-api/v2/portfolio/orders/${orderId}`;

  // Sign and fetch from Kalshi
  let headers: Record<string, string>;
  try {
    headers = buildKalshiAuthHeaders("GET", apiPath);
  } catch (err) {
    return NextResponse.json(
      { error: `Signing error: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }

  let kalshiOrder: Record<string, unknown>;
  try {
    const res = await fetch(`${KALSHI_BASE}/portfolio/orders/${orderId}`, {
      method: "GET",
      headers,
      cache: "no-store",
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.error(`[order-status] Kalshi ${res.status}:`, JSON.stringify(body));
      return NextResponse.json(
        { error: `Kalshi error ${res.status}: ${JSON.stringify(body)}` },
        { status: 502 }
      );
    }

    const json = await res.json();
    // Kalshi returns { order: { ... } }
    kalshiOrder = (json.order ?? json) as Record<string, unknown>;
  } catch (err) {
    return NextResponse.json(
      { error: `Network error: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    );
  }

  const rawStatus      = String(kalshiOrder.status ?? "");
  const orderStatus    = normaliseStatus(rawStatus);
  const filledCount    = Number(kalshiOrder.quantity_matched ?? kalshiOrder.filled_count ?? 0);
  const remainingCount = Number(kalshiOrder.remaining_count ?? 0);
  const now            = new Date().toISOString();

  // Persist to Supabase
  await supabase
    .from("trades")
    .update({
      order_status:     orderStatus,
      filled_count:     filledCount,
      remaining_count:  remainingCount,
      last_checked_at:  now,
    })
    .eq("id", tradeId);

  return NextResponse.json({
    trade_id:        tradeId,
    order_status:    orderStatus,
    filled_count:    filledCount,
    remaining_count: remainingCount,
    last_checked_at: now,
    raw_status:      rawStatus,
  });
}
