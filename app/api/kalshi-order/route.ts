/**
 * GET /api/kalshi-order?order_id=xxx
 *
 * Fetches a single Kalshi order and returns the relevant fields,
 * primarily used to retrieve the limit price of a resting sell order.
 */

import { NextRequest, NextResponse } from "next/server";
import { buildKalshiAuthHeaders } from "@/lib/kalshi-sign";

const DEMO_MODE   = process.env.KALSHI_DEMO_MODE === "true";
const KALSHI_BASE = DEMO_MODE
  ? "https://demo-api.kalshi.co/trade-api/v2"
  : "https://api.elections.kalshi.com/trade-api/v2";

export async function GET(req: NextRequest) {
  const orderId = req.nextUrl.searchParams.get("order_id");
  if (!orderId) {
    return NextResponse.json({ error: "Missing order_id" }, { status: 400 });
  }

  try {
    const path    = `/trade-api/v2/portfolio/orders/${orderId}`;
    const headers = buildKalshiAuthHeaders("GET", path);
    const res     = await fetch(`${KALSHI_BASE}/portfolio/orders/${orderId}`, {
      headers,
      cache: "no-store",
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.error(`[kalshi-order] ${res.status}:`, JSON.stringify(body));
      return NextResponse.json({ error: "Kalshi error", status: res.status }, { status: res.status });
    }

    const json  = await res.json();
    const order = (json.order ?? json) as Record<string, unknown>;

    // yes_price from Kalshi is in integer cents (e.g. 19 = 19¢).
    // Normalise to cents regardless of whether Kalshi returns integer or decimal.
    const rawYes = Number(order.yes_price ?? 0);
    const yes_price_cents = rawYes > 1 ? Math.round(rawYes) : Math.round(rawYes * 100);
    const rawNo  = Number(order.no_price ?? 0);
    const no_price_cents  = rawNo  > 1 ? Math.round(rawNo)  : Math.round(rawNo  * 100);

    return NextResponse.json({
      order_id:          order.order_id,
      status:            order.status,
      action:            order.action,
      side:              order.side,
      yes_price_cents,
      no_price_cents,
      count:             Number(order.count ?? 0),
      remaining_count:   Number(order.remaining_count ?? 0),
      quantity_matched:  Number(order.quantity_matched ?? order.filled_count ?? 0),
    });
  } catch (err) {
    console.error("[kalshi-order] error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
