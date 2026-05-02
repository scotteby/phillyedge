/**
 * POST /api/sync-orders
 *
 * Fetches all resting + partially_filled orders from Kalshi and inserts
 * DB records for any that are missing.  Useful when a boost succeeded on
 * Kalshi but the DB insert failed, leaving a resting order invisible in
 * the app.
 *
 * Returns a list of orders found, which ones were already tracked, and
 * which ones were newly recovered.
 */

import { NextResponse } from "next/server";
import { buildKalshiAuthHeaders } from "@/lib/kalshi-sign";
import { createServiceClient } from "@/lib/supabase/server";
import { deriveTradeSignal } from "@/lib/signal";

const DEMO_MODE   = process.env.KALSHI_DEMO_MODE === "true";
const KALSHI_BASE = DEMO_MODE
  ? "https://demo-api.kalshi.co/trade-api/v2"
  : "https://api.elections.kalshi.com/trade-api/v2";

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

function normaliseStatus(raw: string): string {
  if (raw === "executed" || raw === "filled") return "filled";
  if (raw === "resting")                       return "resting";
  if (raw === "partially_filled")              return "partially_filled";
  if (raw === "canceled" || raw === "cancelled" || raw === "fok_canceled") return "canceled";
  return "resting";
}

export async function POST() {
  const supabase = createServiceClient();

  // ── 1. Fetch all resting + partially_filled orders from Kalshi ────────────
  let headers: Record<string, string>;
  try {
    headers = buildKalshiAuthHeaders("GET", "/trade-api/v2/portfolio/orders");
  } catch (err) {
    return NextResponse.json({ error: `Signing error: ${String(err)}` }, { status: 500 });
  }

  let kalshiOrders: Record<string, unknown>[] = [];
  try {
    // Fetch resting orders
    const restingRes = await fetch(
      `${KALSHI_BASE}/portfolio/orders?status=resting&limit=100`,
      { headers, cache: "no-store" }
    );
    if (restingRes.ok) {
      const j = await restingRes.json();
      kalshiOrders.push(...((j.orders ?? []) as Record<string, unknown>[]));
    }

    // Fetch partially_filled orders
    const partialRes = await fetch(
      `${KALSHI_BASE}/portfolio/orders?status=partially_filled&limit=100`,
      { headers, cache: "no-store" }
    );
    if (partialRes.ok) {
      const j = await partialRes.json();
      kalshiOrders.push(...((j.orders ?? []) as Record<string, unknown>[]));
    }
  } catch (err) {
    return NextResponse.json({ error: `Kalshi fetch error: ${String(err)}` }, { status: 502 });
  }

  if (kalshiOrders.length === 0) {
    return NextResponse.json({ ok: true, found: 0, recovered: [], already_tracked: [] });
  }

  // ── 2. Check which order IDs already have DB records ─────────────────────
  const orderIds = kalshiOrders
    .map((o) => String(o.order_id ?? ""))
    .filter(Boolean);

  const { data: existingRows } = await supabase
    .from("trades")
    .select("kalshi_order_id")
    .in("kalshi_order_id", orderIds);

  const trackedIds = new Set(
    (existingRows ?? []).map((r) => String(r.kalshi_order_id))
  );

  const missing = kalshiOrders.filter(
    (o) => !trackedIds.has(String(o.order_id ?? ""))
  );

  const alreadyTracked = kalshiOrders
    .filter((o) => trackedIds.has(String(o.order_id ?? "")))
    .map((o) => ({ order_id: o.order_id, ticker: o.ticker, status: o.status }));

  if (missing.length === 0) {
    return NextResponse.json({
      ok:              true,
      found:           kalshiOrders.length,
      recovered:       [],
      already_tracked: alreadyTracked,
    });
  }

  // ── 3. Fetch market details + insert missing records ──────────────────────
  const recovered: unknown[] = [];
  const errors:    unknown[] = [];

  for (const order of missing) {
    const orderId = String(order.order_id ?? "");
    const ticker  = String(order.ticker ?? "");
    const side    = String(order.side ?? "yes").toLowerCase() as "yes" | "no";
    const rawStatus = String(order.status ?? "resting");
    const orderStatus = normaliseStatus(rawStatus);

    const count     = parseFloat(String(order.initial_count_fp ?? order.count ?? 0));
    const remaining = parseFloat(String(order.remaining_count_fp ?? order.remaining_count ?? 0));
    const filled    = parseFloat(String(order.fill_count_fp ?? order.filled_count ?? 0));

    const yesPriceCents = parseFloat(String(order.yes_price ?? order.yes_price_dollars ?? 0));
    const noPriceCents  = parseFloat(String(order.no_price  ?? order.no_price_dollars  ?? 0));

    const entryYes = side === "yes"
      ? yesPriceCents / (yesPriceCents > 1 ? 100 : 1)
      : 1 - noPriceCents / (noPriceCents > 1 ? 100 : 1);

    const marketPct = side === "yes"
      ? Math.round(yesPriceCents > 1 ? yesPriceCents : yesPriceCents * 100)
      : Math.round(noPriceCents  > 1 ? noPriceCents  : noPriceCents  * 100);

    const edge   = 50 - marketPct; // no forecast available here
    const signal = deriveTradeSignal(side.toUpperCase() as "YES" | "NO", edge);
    const amount = count * (side === "yes" ? entryYes : 1 - entryYes);

    // Fetch market title + target_date
    let marketQuestion = ticker;
    let targetDate: string | null = null;
    try {
      const mktRes = await fetch(
        `${KALSHI_BASE}/markets/${encodeURIComponent(ticker)}`,
        { headers: { Accept: "application/json" }, cache: "no-store" }
      );
      if (mktRes.ok) {
        const mktJson = await mktRes.json();
        const mkt = (mktJson.market ?? mktJson) as Record<string, unknown>;
        marketQuestion = String(mkt.title ?? mkt.subtitle ?? ticker);
        targetDate = String(mkt.close_time ?? mkt.expiration_time ?? "").slice(0, 10) || null;
      }
    } catch { /* non-fatal */ }

    const { data: inserted, error: insertErr } = await supabase
      .from("trades")
      .insert([{
        market_id:       ticker,
        market_question: marketQuestion,
        target_date:     targetDate,
        side:            side.toUpperCase(),
        amount_usdc:     amount,
        market_pct:      marketPct,
        my_pct:          50,
        edge,
        signal,
        outcome:         "pending",
        pnl:             null,
        polymarket_url:  kalshiUrl(ticker),
        kalshi_order_id: orderId,
        order_status:    orderStatus,
        entry_yes_price: entryYes,
        filled_count:    Math.round(filled),
        remaining_count: Math.round(remaining),
      }])
      .select("id")
      .single();

    if (insertErr) {
      errors.push({ order_id: orderId, ticker, error: insertErr.message });
    } else {
      recovered.push({
        trade_id:    (inserted as { id: string }).id,
        order_id:    orderId,
        ticker,
        side:        side.toUpperCase(),
        order_status: orderStatus,
        market_pct:  marketPct,
        count,
        filled,
        remaining,
      });
    }
  }

  return NextResponse.json({
    ok:              errors.length === 0,
    found:           kalshiOrders.length,
    recovered,
    already_tracked: alreadyTracked,
    errors:          errors.length > 0 ? errors : undefined,
  });
}
