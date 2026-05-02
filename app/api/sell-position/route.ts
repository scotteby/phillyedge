import { NextRequest, NextResponse } from "next/server";
import { buildKalshiAuthHeaders } from "@/lib/kalshi-sign";
import { createServiceClient } from "@/lib/supabase/server";

const DEMO_MODE   = process.env.KALSHI_DEMO_MODE === "true";
const KALSHI_BASE = DEMO_MODE
  ? "https://demo-api.kalshi.co/trade-api/v2"
  : "https://api.elections.kalshi.com/trade-api/v2";
const ORDER_PATH  = "/trade-api/v2/portfolio/orders";

export async function POST(req: NextRequest) {
  let body: { trade_id: string; sell_price_cents?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { trade_id, sell_price_cents } = body;
  if (!trade_id) {
    return NextResponse.json({ error: "Missing trade_id" }, { status: 400 });
  }

  const supabase = createServiceClient();

  // Look up the trade
  const { data: trade, error: dbErr } = await supabase
    .from("trades")
    .select("id, market_id, side, filled_count, amount_usdc, entry_yes_price, market_pct, kalshi_order_id, outcome, order_status")
    .eq("id", trade_id)
    .single();

  if (dbErr || !trade) {
    return NextResponse.json({ error: "Trade not found" }, { status: 404 });
  }

  if (trade.outcome !== "pending") {
    return NextResponse.json({ error: "Trade is already settled" }, { status: 422 });
  }

  const side   = (trade.side as string).toLowerCase() as "yes" | "no";
  const entryYesStored = trade.entry_yes_price as number | null;
  const entryYesCalc   =
    entryYesStored ??
    (side === "yes"
      ? (trade.market_pct as number) / 100
      : 1 - (trade.market_pct as number) / 100);
  const entryCostPerContract = side === "yes" ? entryYesCalc : 1 - entryYesCalc;

  // filled_count may be null if order-status polling hasn't persisted it yet.
  // Fetch the original order from Kalshi to get the real fill count.
  let filledCount = (trade.filled_count as number | null) ?? 0;

  if (filledCount < 1 && trade.kalshi_order_id) {
    try {
      const origOrderPath = `/trade-api/v2/portfolio/orders/${trade.kalshi_order_id}`;
      const origHeaders   = buildKalshiAuthHeaders("GET", origOrderPath);
      const origRes       = await fetch(`${KALSHI_BASE}/portfolio/orders/${trade.kalshi_order_id}`, {
        method: "GET", headers: origHeaders, cache: "no-store",
      });
      if (origRes.ok) {
        const origJson  = await origRes.json();
        const origOrder = (origJson.order ?? origJson) as Record<string, unknown>;
        const fetched   = Number(origOrder.quantity_matched ?? origOrder.filled_count ?? 0);
        if (fetched > 0) filledCount = fetched;
        console.log(`[sell-position] original order fill count from Kalshi: ${fetched}`);
      }
    } catch { /* fall through to estimate */ }
  }

  // Final fallback: estimate from amount_usdc / entry price
  if (filledCount < 1 && entryCostPerContract > 0) {
    filledCount = Math.floor((trade.amount_usdc as number) / entryCostPerContract);
    console.log(`[sell-position] estimated fill count from amount: ${filledCount}`);
  }

  if (filledCount < 1) {
    return NextResponse.json({ error: "No filled contracts to sell" }, { status: 422 });
  }

  const ticker = trade.market_id as string;

  // Build sell order.
  // If the caller provides a sell_price_cents (fetched from the real-time orderbook),
  // place a limit order at that price so the user gets approximately what they saw
  // in the confirmation modal.  Fall back to 1¢ (market sweep) only when no price
  // is supplied, so the order always fills.
  const priceForOrder = sell_price_cents != null
    ? Math.max(1, Math.round(sell_price_cents))
    : 1;

  const orderBody = {
    ticker,
    action: "sell",
    side,
    type:   priceForOrder > 1 ? "limit" : "market",
    count:  filledCount,
    ...(side === "yes" ? { yes_price: priceForOrder } : { no_price: priceForOrder }),
  };

  console.log("[sell-position] order body:", JSON.stringify(orderBody));

  // Sign the request
  let headers: Record<string, string>;
  try {
    headers = buildKalshiAuthHeaders("POST", ORDER_PATH);
  } catch (err) {
    return NextResponse.json(
      { error: `Signing error: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }

  // Submit sell order to Kalshi
  let sellOrderId: string | null = null;
  let initialOrder: Record<string, unknown> = {};

  try {
    const kalshiRes = await fetch(`${KALSHI_BASE}/portfolio/orders`, {
      method:  "POST",
      headers,
      body:    JSON.stringify(orderBody),
    });

    const kalshiJson = await kalshiRes.json();

    if (!kalshiRes.ok) {
      console.error(`[sell-position] Kalshi ${kalshiRes.status}:`, JSON.stringify(kalshiJson));
      const raw = kalshiJson?.message ?? kalshiJson?.error ?? kalshiJson;
      const msg = typeof raw === "string" ? raw : JSON.stringify(raw);
      return NextResponse.json({ error: `Kalshi rejected sell: ${msg}` }, { status: 502 });
    }

    initialOrder = (kalshiJson?.order ?? kalshiJson) as Record<string, unknown>;
    sellOrderId  = (initialOrder.order_id as string | null) ?? null;
    console.log("[sell-position] Kalshi response:", JSON.stringify(initialOrder));
  } catch (err) {
    return NextResponse.json(
      { error: `Network error: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    );
  }

  // Attempt to fetch the sell order status for fill price
  let filledOrder: Record<string, unknown> = initialOrder;
  if (sellOrderId) {
    try {
      const apiPath    = `/trade-api/v2/portfolio/orders/${sellOrderId}`;
      const getHeaders = buildKalshiAuthHeaders("GET", apiPath);
      const statusRes  = await fetch(`${KALSHI_BASE}/portfolio/orders/${sellOrderId}`, {
        method:  "GET",
        headers: getHeaders,
        cache:   "no-store",
      });
      if (statusRes.ok) {
        const statusJson = await statusRes.json();
        filledOrder = (statusJson.order ?? statusJson) as Record<string, unknown>;
        console.log("[sell-position] fill status:", JSON.stringify(filledOrder));
      }
    } catch { /* non-fatal — fall back to initial response */ }
  }

  // Extract avg fill price (YES price in 0–1 decimal or integer cents)
  // Kalshi may use different field names depending on version
  const rawPrice =
    filledOrder.avg_yes_price  ??
    filledOrder.avg_fill_price ??
    filledOrder.yes_price      ??
    initialOrder.avg_yes_price ??
    initialOrder.avg_fill_price ??
    null;

  let avgFillYesPrice: number | null = null;
  if (rawPrice != null) {
    const n = Number(rawPrice);
    // Kalshi can return integer cents (e.g. 45) or decimal (e.g. 0.45)
    // Guard against the submitted 1¢ floor price leaking in as the "fill" price.
    if (n > 1) avgFillYesPrice = n / 100;
    else if (n > 0 && n <= 1) avgFillYesPrice = n;
  }
  // Fallback: use the confirmed sell price from the UI (what the user saw).
  // sell_price_cents is the side-specific bid (YES cents for YES, NO cents for NO).
  // Convert to a YES-side price for the pnl calc below.
  if (avgFillYesPrice == null && sell_price_cents != null && sell_price_cents > 1) {
    avgFillYesPrice = side === "yes"
      ? sell_price_cents / 100
      : 1 - sell_price_cents / 100;
  }

  // Calculate P&L (reuse entryYesCalc / entryCostPerContract computed above)
  const proceedsPerContract = avgFillYesPrice != null
    ? (side === "yes" ? avgFillYesPrice : 1 - avgFillYesPrice)
    : null;

  const pnl = proceedsPerContract != null
    ? parseFloat(((proceedsPerContract - entryCostPerContract) * filledCount).toFixed(2))
    : null;

  // Update trade in Supabase: mark as sold
  const now = new Date().toISOString();
  const { error: dbUpdateErr } = await supabase
    .from("trades")
    .update({ outcome: "sold", pnl, last_checked_at: now })
    .eq("id", trade_id);

  if (dbUpdateErr) {
    // Non-fatal — the Kalshi sell already succeeded. Log loudly so we know to reconcile.
    console.error(`[sell-position] WARN: Supabase update failed for trade ${trade_id}:`, dbUpdateErr.message);
  }

  console.log(`[sell-position] ${ticker} sold ${filledCount}×${side} avgFillYes=${avgFillYesPrice} pnl=${pnl}`);

  return NextResponse.json({
    ok:             true,
    trade_id,
    sell_order_id:  sellOrderId,
    contracts_sold: filledCount,
    avg_fill_yes_price: avgFillYesPrice,
    pnl,
  });
}
