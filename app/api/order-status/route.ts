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

  // Kalshi v2 uses *_fp (fixed-point) string fields for counts
  const filledCount    = parseFloat(String(kalshiOrder.fill_count_fp    ?? kalshiOrder.filled_count    ?? 0));
  const remainingCount = parseFloat(String(kalshiOrder.remaining_count_fp ?? kalshiOrder.remaining_count ?? 0));
  const initialCount   = parseFloat(String(kalshiOrder.initial_count_fp  ?? kalshiOrder.count          ?? 0));

  // For fully-executed orders with 0 fill_count_fp, fall back to initial_count
  const effectiveFilled = (filledCount > 0) ? filledCount
    : (orderStatus === "filled" && remainingCount === 0 ? initialCount : 0);

  console.log(`[order-status] ${tradeId} | ${trade.market_id} | status=${rawStatus} fill_count_fp=${kalshiOrder.fill_count_fp} initial_count_fp=${kalshiOrder.initial_count_fp} remaining_count_fp=${kalshiOrder.remaining_count_fp} → effectiveFilled=${effectiveFilled} taker_cost=${kalshiOrder.taker_fill_cost_dollars}`);

  const now = new Date().toISOString();

  // Average fill price — prefer avg_yes_price / avg_fill_price from Kalshi (native avg fill
  // price), fall back to the limit price (yes_price_dollars).
  // NOTE: taker_fill_cost_dollars is the taker FEE, NOT total fill cost — do NOT divide it
  // by contract count to derive a price.
  const side = String(trade.side ?? "").toLowerCase();

  // Build the update — only overwrite entry_yes_price when we have real fill data
  const dbUpdate: Record<string, unknown> = {
    order_status:    orderStatus,
    filled_count:    Math.round(effectiveFilled),
    remaining_count: Math.round(remainingCount),
    last_checked_at: now,
  };

  if (effectiveFilled > 0) {
    // Try the native avg-fill-price fields first (most accurate)
    const rawAvg =
      kalshiOrder.avg_yes_price  ??
      kalshiOrder.avg_fill_price ??
      null;

    if (rawAvg != null) {
      const n = Number(rawAvg);
      // Kalshi can return integer cents (e.g. 45) or decimal (e.g. 0.45)
      const avgYesPrice = n > 1 ? n / 100 : n;
      if (avgYesPrice > 0 && avgYesPrice < 1) {
        dbUpdate.entry_yes_price = side === "yes" ? avgYesPrice : 1 - avgYesPrice;
      }
    } else {
      // Fall back to the order's limit price
      const yesPrice = parseFloat(String(kalshiOrder.yes_price_dollars ?? 0));
      if (yesPrice > 0) dbUpdate.entry_yes_price = yesPrice;
    }
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

  // ── Detect a completed sell order ────────────────────────────────────────
  // When the user placed a limit sell that was resting, kalshi_order_id was
  // swapped to the sell order.  Detect this by checking action === "sell" on
  // the polled Kalshi order.
  const kalshiAction = String(kalshiOrder.action ?? "").toLowerCase();
  const isSellOrder  = kalshiAction === "sell";

  if (isSellOrder && orderStatus === "filled" && outcome === "pending") {
    const tradeSide = String(trade.side ?? "").toLowerCase();

    // Best available avg fill YES price
    const rawAvg =
      kalshiOrder.avg_yes_price  ??
      kalshiOrder.avg_fill_price ??
      null;

    let avgFillYesPrice: number | null = null;
    if (rawAvg != null) {
      const n = Number(rawAvg);
      if (n > 1) avgFillYesPrice = n / 100;
      else if (n > 0 && n <= 1) avgFillYesPrice = n;
    }

    const entryYes: number =
      (trade.entry_yes_price as number | null) ??
      (tradeSide === "yes"
        ? (trade.market_pct as number) / 100
        : 1 - (trade.market_pct as number) / 100);

    const entryCostPerContract = tradeSide === "yes" ? entryYes : 1 - entryYes;
    const proceedsPerContract  = avgFillYesPrice != null
      ? (tradeSide === "yes" ? avgFillYesPrice : 1 - avgFillYesPrice)
      : null;

    pnl = proceedsPerContract != null
      ? parseFloat(((proceedsPerContract - entryCostPerContract) * effectiveFilled).toFixed(2))
      : null;

    outcome  = "sold";
    resolved = true;

    await supabase
      .from("trades")
      .update({ outcome: "sold", pnl })
      .eq("id", tradeId);

    console.log(`[order-status] Sell order ${orderId} filled → outcome=sold, pnl=${pnl}`);
  }

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
            ? parseFloat((effectiveFilled * (1 - sidePrice)).toFixed(2))
            : parseFloat((-(effectiveFilled * sidePrice)).toFixed(2));
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
    filled_count:    Math.round(effectiveFilled),
    remaining_count: Math.round(remainingCount),
    last_checked_at: now,
    raw_status:      rawStatus,
    outcome,
    pnl,
    resolved,
    // Return updated entry_yes_price so the client state reflects real fill price
    ...(dbUpdate.entry_yes_price != null ? { entry_yes_price: dbUpdate.entry_yes_price } : {}),
  });
}
