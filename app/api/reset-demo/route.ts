/**
 * POST /api/reset-demo
 *
 * Nuclear reset for the demo environment:
 *   1. Cancels all live resting/partial demo orders on the Kalshi demo exchange.
 *   2. Deletes ALL demo=true trades from Supabase.
 *   3. Runs runDemoTrading() to place fresh orders.
 *
 * Returns the DemoTradingResult from the fresh run.
 */

import { NextResponse }        from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { buildKalshiAuthHeaders } from "@/lib/kalshi-sign";
import { runDemoTrading }       from "@/lib/demo-trading";

const DEMO_BASE       = "https://demo-api.kalshi.co/trade-api/v2";
const ORDERS_API_PATH = "/trade-api/v2/portfolio/orders";

async function cancelKalshiDemoOrder(orderId: string): Promise<void> {
  try {
    const path    = `${ORDERS_API_PATH}/${orderId}`;
    const headers = buildKalshiAuthHeaders("DELETE", path, true);
    await fetch(`${DEMO_BASE}/portfolio/orders/${orderId}`, {
      method: "DELETE", headers, cache: "no-store",
    });
  } catch {
    // Non-fatal
  }
}

export async function POST() {
  const supabase = createServiceClient();

  // 1. Find all live demo orders to cancel on Kalshi
  const { data: liveRows } = await supabase
    .from("trades")
    .select("id, kalshi_order_id, order_status")
    .eq("demo", true)
    .in("order_status", ["resting", "partially_filled"])
    .not("kalshi_order_id", "is", null);

  const liveOrders = (liveRows ?? []).filter((r) => r.kalshi_order_id);

  if (liveOrders.length > 0) {
    console.log(`[reset-demo] Canceling ${liveOrders.length} live Kalshi demo orders…`);
    await Promise.all(
      liveOrders.map((r) => cancelKalshiDemoOrder(r.kalshi_order_id as string)),
    );
  }

  // 2. Delete ALL demo trades from Supabase
  const { error: delErr, count } = await supabase
    .from("trades")
    .delete({ count: "exact" })
    .eq("demo", true);

  if (delErr) {
    console.error("[reset-demo] Delete failed:", delErr.message);
    return NextResponse.json({ error: `Delete failed: ${delErr.message}` }, { status: 500 });
  }

  console.log(`[reset-demo] Deleted ${count ?? "?"} demo trades`);

  // 3. Place fresh demo orders
  let result;
  try {
    result = await runDemoTrading();
  } catch (err) {
    return NextResponse.json({
      error: `runDemoTrading failed: ${err instanceof Error ? err.message : String(err)}`,
      deleted: count ?? 0,
    }, { status: 500 });
  }

  return NextResponse.json({
    ok:      true,
    deleted: count ?? 0,
    ...result,
  });
}
