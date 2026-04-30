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
    default:                  return "resting";
  }
}

export async function GET(req: NextRequest) {
  const tradeId = req.nextUrl.searchParams.get("trade_id");
  if (!tradeId) {
    return NextResponse.json({ error: "Missing trade_id query param" }, { status: 400 });
  }

  const supabase = createServiceClient();

  // Fetch trade — include fields needed for resolution calc
  const { data: trade, error: dbErr } = await supabase
    .from("trades")
    .select("id, kalshi_order_id, order_status, market_id, side, entry_yes_price, market_pct, outcome")
    .eq("id", tradeId)
    .single();

  if (dbErr || !trade) {
    return NextResponse.json({ error: "Trade not found" }, { status: 404 });
  }

  if (!trade.kalshi_order_id) {
    return NextResponse.json({ error: "No Kalshi order ID for this trade" }, { status: 422 });
  }

  const orderId = trade.kalshi_order_id as string;
  const apiPath = `/trade-api/v2/portfolio/orders/${orderId}`;

  // ── Fetch order status from Kalshi (authenticated) ───────────────────────

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
    kalshiOrder = (json.order ?? json) as Record<string, unknown>;
  } catch (err) {
    return NextResponse.json(
      { error: `Network error: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    );
  }

  console.log("[order-status] FULL order response:", JSON.stringify(kalshiOrder));

  const rawStatus   = String(kalshiOrder.status ?? "");
  const orderStatus = normaliseStatus(rawStatus);

  // Kalshi uses several field names across API versions; try them all.
  // For a fully-executed order, fall back to "count" (total order size) which
  // equals the number of contracts filled when remaining_count = 0.
  const remaining   = Number(kalshiOrder.remaining_count ?? 0);
  const filledCount = Number(
    kalshiOrder.filled_count ??
    kalshiOrder.quantity_matched ??
    kalshiOrder.amount_matched ??
    // If the order is fully filled, total order size = filled count
    (orderStatus === "filled" && remaining === 0
      ? (kalshiOrder.count ?? kalshiOrder.original_count)
      : undefined) ??
    0
  );
  const remainingCount = remaining;
  const now            = new Date().toISOString();

  // Average fill price in cents (Kalshi field names vary by version)
  // Convert to 0–1 decimal for entry_yes_price storage.
  const avgPriceCents = Number(
    kalshiOrder.avg_price ??
    kalshiOrder.average_price ??
    kalshiOrder.avg_fill_price ??
    0
  );

  // Build the update — only overwrite entry_yes_price when we have a real avg price,
  // so we don't clobber a good stored value with 0.
  const dbUpdate: Record<string, unknown> = {
    order_status:    orderStatus,
    filled_count:    filledCount,
    remaining_count: remainingCount,
    last_checked_at: now,
  };

  if (avgPriceCents > 0 && filledCount > 0) {
    const side = String(trade.side ?? "").toLowerCase();
    // avg_price from Kalshi is the price of the side you bought (YES or NO), in cents
    const avgDecimal    = avgPriceCents / 100;
    dbUpdate.entry_yes_price = side === "yes" ? avgDecimal : 1 - avgDecimal;
  }

  // ── Persist order fields to Supabase ────────────────────────────────────

  await supabase
    .from("trades")
    .update(dbUpdate)
    .eq("id", tradeId);

  // ── Check market resolution (public endpoint, no auth) ───────────────────
  // Only bother if the outcome is still pending.

  let outcome: string  = trade.outcome ?? "pending";
  let pnl:     number | null = null;
  let resolved = false;

  if (outcome === "pending" && trade.market_id) {
    try {
      const mktRes = await fetch(
        `${KALSHI_BASE}/markets/${encodeURIComponent(trade.market_id as string)}`,
        { headers: { Accept: "application/json" }, cache: "no-store" }
      );

      if (mktRes.ok) {
        const mktJson  = await mktRes.json();
        const mkt      = (mktJson.market ?? mktJson) as Record<string, unknown>;
        const mktStatus = String(mkt.status ?? "").toLowerCase();
        const result    = String(mkt.result  ?? "").toLowerCase(); // "yes" | "no" | ""

        if (mktStatus === "finalized" && (result === "yes" || result === "no")) {
          const tradeSide = String(trade.side ?? "").toLowerCase(); // "yes" | "no"
          const won       = result === tradeSide;

          // Entry price of the purchased side (0–1 decimal)
          const entryYes: number =
            (trade.entry_yes_price as number | null) ??
            (tradeSide === "yes"
              ? (trade.market_pct as number) / 100
              : 1 - (trade.market_pct as number) / 100);
          const sidePrice = tradeSide === "yes" ? entryYes : 1 - entryYes;

          // Net P&L:
          //   Win:  filled_count × (1 − side_entry_price)  — profit per contract
          //   Loss: −(filled_count × side_entry_price)     — capital lost
          pnl     = won
            ? parseFloat((filledCount * (1 - sidePrice)).toFixed(2))
            : parseFloat((-(filledCount * sidePrice)).toFixed(2));
          outcome = won ? "win" : "loss";
          resolved = true;

          await supabase
            .from("trades")
            .update({ outcome, pnl })
            .eq("id", tradeId);

          console.log(`[order-status] Market ${trade.market_id} finalized → ${outcome}, pnl=${pnl}`);
        }
      }
    } catch (err) {
      // Non-fatal — order status still returned below
      console.error("[order-status] Market resolution check failed:", err);
    }
  }

  return NextResponse.json({
    trade_id:        tradeId,
    order_status:    orderStatus,
    filled_count:    filledCount,
    remaining_count: remainingCount,
    last_checked_at: now,
    raw_status:      rawStatus,
    outcome,
    pnl,
    resolved,
  });
}
