/**
 * GET /api/live-price?ticker=KXHIGHPHIL-26APR29-B66.5
 *
 * Fetches the current Kalshi market price for a single ticker.
 * Market data is public — no auth headers required.
 *
 * Returns: { ticker, yes_price, status }
 *   yes_price: mid-price if bid+ask available, else last_price, else null
 */

import { NextRequest, NextResponse } from "next/server";

const DEMO_MODE   = process.env.KALSHI_DEMO_MODE === "true";
const KALSHI_BASE = DEMO_MODE
  ? "https://demo-api.kalshi.co/trade-api/v2"
  : "https://api.elections.kalshi.com/trade-api/v2";

function midPrice(
  bid: string | undefined,
  ask: string | undefined,
  last: string | undefined,
): number | null {
  const b = parseFloat(bid ?? "0");
  const a = parseFloat(ask ?? "0");
  if (b > 0 && a > 0) return (b + a) / 2;
  const l = parseFloat(last ?? "0");
  if (l > 0) return l;
  return null;
}

export async function GET(req: NextRequest) {
  const ticker = req.nextUrl.searchParams.get("ticker");
  if (!ticker) {
    return NextResponse.json({ error: "Missing ticker" }, { status: 400 });
  }

  try {
    const res = await fetch(`${KALSHI_BASE}/markets/${encodeURIComponent(ticker)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Kalshi ${res.status}` },
        { status: 502 }
      );
    }

    const json = await res.json();
    // Kalshi returns { market: { ... } }
    const m = json.market ?? json;

    const yes_price = midPrice(
      m.yes_bid_dollars,
      m.yes_ask_dollars,
      m.last_price_dollars,
    );

    return NextResponse.json({
      ticker,
      yes_price,
      market_status: m.status ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Network error: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    );
  }
}
