import { NextRequest, NextResponse } from "next/server";
import { buildKalshiAuthHeaders } from "@/lib/kalshi-sign";
import { createServiceClient } from "@/lib/supabase/server";
import { deriveTradeSignal } from "@/lib/signal";
import { linkTradeToRecommendation } from "@/lib/rec-log";

const DEMO_MODE  = process.env.KALSHI_DEMO_MODE === "true";
const KALSHI_BASE = DEMO_MODE
  ? "https://demo-api.kalshi.co/trade-api/v2"
  : "https://api.elections.kalshi.com/trade-api/v2";
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

  // Kalshi orders API uses integer cents (1–99), not decimal dollars.
  // yes_price / no_price must be a whole number e.g. 35 not 0.35.
  const priceCents = Math.round(price * 100);

  // ── Build Kalshi order body ──────────────────────────────────────────────────
  const orderBody: Record<string, unknown> = {
    ticker,
    action: "buy",
    side:   sideLower,
    type:   "limit",
    count,
    ...(sideLower === "yes"
      ? { yes_price: priceCents }
      : { no_price:  priceCents }),
  };

  console.log("[place-trade] order body:", JSON.stringify(orderBody));

  // ── Sign and submit to Kalshi ────────────────────────────────────────────────
  let orderId: string | null = null;

  // ── Sign the request (key errors surface here, before any network call) ────
  let headers: Record<string, string>;
  try {
    headers = buildKalshiAuthHeaders("POST", ORDER_PATH);
  } catch (err) {
    return NextResponse.json(
      {
        error:      `Signing error: ${err instanceof Error ? err.message : String(err)}`,
        kalshi_url: kalshiUrl(ticker),
      },
      { status: 500 }
    );
  }

  // ── Submit order to Kalshi ──────────────────────────────────────────────────
  try {
    const kalshiRes = await fetch(`${KALSHI_BASE}/portfolio/orders`, {
      method:  "POST",
      headers,
      body:    JSON.stringify(orderBody),
    });

    const kalshiJson = await kalshiRes.json();

    if (!kalshiRes.ok) {
      // Log full Kalshi response server-side for debugging
      console.error(`[place-trade] Kalshi ${kalshiRes.status}:`, JSON.stringify(kalshiJson));

      const raw = kalshiJson?.message ?? kalshiJson?.error ?? kalshiJson;
      const kalshiMsg = typeof raw === "string" ? raw : JSON.stringify(raw);

      // Build a user-facing error with a hint for common status codes
      let hint = "";
      if (kalshiRes.status === 401) {
        hint = DEMO_MODE
          ? " — demo API requires separate demo credentials (api.elections.kalshi.com and demo-api.kalshi.co use different accounts)"
          : " — check that KALSHI_API_KEY_ID matches the private key in your Kalshi account settings";
      } else if (kalshiRes.status === 403) {
        hint = " — your API key may not have trading permissions";
      } else if (kalshiRes.status === 422) {
        hint = " — order was rejected (check price, count, or market status)";
      }

      return NextResponse.json(
        {
          error:      `Kalshi rejected the order: ${kalshiMsg}${hint}`,
          kalshi_url: kalshiUrl(ticker),
        },
        // Always return 502 — never forward Kalshi's 4xx to the browser,
        // which would cause a console error and swallow the JSON body.
        { status: 502 }
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
        error:      `Network error reaching Kalshi: ${err instanceof Error ? err.message : String(err)}`,
        kalshi_url: kalshiUrl(ticker),
      },
      { status: 502 }
    );
  }

  // ── Log to Supabase ──────────────────────────────────────────────────────────
  // Derive the signal relative to the side actually traded.
  // A NO trade on a strong-NO bracket is a "Strong Buy" of the correct side.
  const dbSignal = deriveTradeSignal(side.toUpperCase() as "YES" | "NO", edge);

  try {
    const supabase = createServiceClient();
    const { data: inserted, error: dbErr } = await supabase
      .from("trades")
      .insert([
        {
          market_id:        ticker,
          market_question,
          target_date,
          side:             side.toUpperCase(),
          amount_usdc:      amount,
          market_pct,
          my_pct,
          edge,
          signal:           dbSignal,
          outcome:          "pending",
          pnl:              null,
          polymarket_url:   kalshiUrl(ticker),
          kalshi_order_id:  orderId,
          order_status:     orderId ? "resting" : null,
          entry_yes_price:  sideLower === "yes" ? price : 1 - price,
        },
      ])
      .select("id")
      .single();
    if (dbErr) {
      // Surface DB errors so they're visible in the response (non-fatal —
      // the Kalshi order already succeeded at this point).
      console.error("[place-trade] Supabase insert failed:", dbErr.message);
    } else if (inserted?.id) {
      // Phase 2.5: fire-and-forget link to recommendation_log.
      // Failure must never affect trade confirmation.
      void linkTradeToRecommendation(
        inserted.id as string,
        ticker,
        target_date,
        supabase,
      ).catch((e) => console.error("[rec-log] linkTradeToRecommendation failed:", e));
    }
  } catch (err) {
    console.error("[place-trade] Supabase insert threw:", err);
  }

  return NextResponse.json({
    ok:            true,
    order_id:      orderId,
    ticker,
    side:          side.toUpperCase(),
    count,
    price_dollars:  price,
    amount_dollars: amount,
    demo:           DEMO_MODE,
  });
}
