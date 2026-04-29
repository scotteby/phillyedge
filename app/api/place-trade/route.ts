import { NextRequest, NextResponse } from "next/server";
import { buildKalshiAuthHeaders } from "@/lib/kalshi-sign";
import { createServiceClient } from "@/lib/supabase/server";

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const ORDER_PATH  = "/trade-api/v2/portfolio/orders";

const SERIES_SLUGS: Record<string, string> = {
  kxhighphil:   "highest-temperature-in-philadelphia",
  kxlowtphil:   "lowest-temperature-in-philadelphia",
  kxprecipphil: "precipitation-in-philadelphia",
};

function kalshiUrl(ticker: string): string {
  const series = ticker.split("-")[0].toLowerCase();
  const slug   = SERIES_SLUGS[series] ?? series;
  return `https://kalshi.com/markets/${series}/${slug}/${ticker.toLowerCase()}`;
}

export async function POST(req: NextRequest) {
  let body: {
    ticker:           string;
    side:             string;
    amount_dollars:   number;
    limit_price:      number;
    // Supabase logging
    market_question:  string;
    target_date:      string;
    market_pct:       number;
    my_pct:           number;
    edge:             number;
    signal:           string;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const {
    ticker, side, amount_dollars, limit_price,
    market_question, target_date, market_pct, my_pct, edge, signal,
  } = body;

  // ── Validate inputs ──────────────────────────────────────────────────────────
  if (!ticker || !side || !amount_dollars || !limit_price) {
    return NextResponse.json({ error: "Missing required fields: ticker, side, amount_dollars, limit_price" }, { status: 400 });
  }

  const price  = Number(limit_price);
  const amount = Number(amount_dollars);
  const count  = Math.floor(amount / price);

  if (count < 1) {
    return NextResponse.json(
      {
        error: `Amount $${amount.toFixed(2)} at ${(price * 100).toFixed(0)}¢/contract = 0 contracts. Need at least $${price.toFixed(2)}.`,
        kalshi_url: kalshiUrl(ticker),
      },
      { status: 400 }
    );
  }

  const sideLower = side.toLowerCase() as "yes" | "no";

  // ── Build Kalshi order body ──────────────────────────────────────────────────
  const orderBody: Record<string, unknown> = {
    ticker,
    action: "buy",
    side:   sideLower,
    type:   "limit",
    count,
    ...(sideLower === "yes"
      ? { yes_price_dollars: price }
      : { no_price_dollars:  price }),
  };

  // ── Sign and submit to Kalshi ────────────────────────────────────────────────
  let orderId: string | null = null;

  try {
    const headers = buildKalshiAuthHeaders("POST", ORDER_PATH);

    const kalshiRes = await fetch(`${KALSHI_BASE}/portfolio/orders`, {
      method:  "POST",
      headers,
      body:    JSON.stringify(orderBody),
    });

    const kalshiJson = await kalshiRes.json();

    if (!kalshiRes.ok) {
      const msg = kalshiJson?.message ?? kalshiJson?.error ?? `Kalshi returned HTTP ${kalshiRes.status}`;
      return NextResponse.json(
        {
          error:            msg,
          kalshi_response:  kalshiJson,
          kalshi_url:       kalshiUrl(ticker),
        },
        { status: kalshiRes.status >= 500 ? 502 : kalshiRes.status }
      );
    }

    // Kalshi returns { order: { order_id, ... } } or { order_id, ... }
    orderId =
      kalshiJson?.order?.order_id ??
      kalshiJson?.order_id ??
      null;

  } catch (err) {
    return NextResponse.json(
      {
        error:      `Network error reaching Kalshi: ${String(err)}`,
        kalshi_url: kalshiUrl(ticker),
      },
      { status: 502 }
    );
  }

  // ── Log to Supabase ──────────────────────────────────────────────────────────
  try {
    const supabase = createServiceClient();
    await supabase.from("trades").insert([
      {
        market_id:        ticker,
        market_question,
        target_date,
        side:             side.toUpperCase(),
        amount_usdc:      amount,
        market_pct,
        my_pct,
        edge,
        signal,
        outcome:          "pending",
        pnl:              null,
        polymarket_url:   kalshiUrl(ticker),
        kalshi_order_id:  orderId,
      },
    ]);
  } catch (err) {
    // Logging failure is non-fatal — order already placed, just warn
    console.error("Failed to log trade to Supabase:", err);
  }

  return NextResponse.json({
    ok:            true,
    order_id:      orderId,
    ticker,
    side:          side.toUpperCase(),
    count,
    price_dollars: price,
    amount_dollars: amount,
  });
}
