/**
 * GET /api/orderbook?ticker=KXHIGHPHIL-26APR29-B66.5
 *
 * Returns current ask/bid prices for a Kalshi market ticker.
 * Uses the public markets endpoint (no auth) — same data we use for
 * live prices, just surfacing yes_ask/yes_bid explicitly so the
 * Boost modal can show the "match ask" option.
 *
 * Returns (all values in integer cents, 0–99):
 *   yes_ask_cents   — price to buy YES immediately (sell-side YES)
 *   yes_bid_cents   — best bid for YES (buy-side YES)
 *   no_ask_cents    — price to buy NO immediately  (= 100 - yes_bid)
 *   no_bid_cents    — best bid for NO              (= 100 - yes_ask)
 */

import { NextRequest, NextResponse } from "next/server";

const DEMO_MODE   = process.env.KALSHI_DEMO_MODE === "true";
const KALSHI_BASE = DEMO_MODE
  ? "https://demo-api.kalshi.co/trade-api/v2"
  : "https://api.elections.kalshi.com/trade-api/v2";

export async function GET(req: NextRequest) {
  const ticker = req.nextUrl.searchParams.get("ticker");
  if (!ticker) {
    return NextResponse.json({ error: "Missing ticker" }, { status: 400 });
  }

  try {
    const res = await fetch(
      `${KALSHI_BASE}/markets/${encodeURIComponent(ticker)}`,
      { headers: { Accept: "application/json" }, cache: "no-store" }
    );

    if (!res.ok) {
      return NextResponse.json({ error: `Kalshi ${res.status}` }, { status: 502 });
    }

    const json = await res.json();
    const m    = json.market ?? json;

    const yesAskDollars = parseFloat(m.yes_ask_dollars ?? m.yes_ask ?? "0");
    const yesBidDollars = parseFloat(m.yes_bid_dollars ?? m.yes_bid ?? "0");

    const yesAskCents = yesAskDollars > 0 ? Math.round(yesAskDollars * 100) : null;
    const yesBidCents = yesBidDollars > 0 ? Math.round(yesBidDollars * 100) : null;
    const noAskCents  = yesBidCents  != null ? 100 - yesBidCents  : null;
    const noBidCents  = yesAskCents  != null ? 100 - yesAskCents  : null;

    console.log(`[orderbook] ${ticker}: YES ask=${yesAskCents}¢ bid=${yesBidCents}¢`);

    return NextResponse.json({ ticker, yes_ask_cents: yesAskCents, yes_bid_cents: yesBidCents, no_ask_cents: noAskCents, no_bid_cents: noBidCents });
  } catch (err) {
    return NextResponse.json(
      { error: `Network error: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    );
  }
}
