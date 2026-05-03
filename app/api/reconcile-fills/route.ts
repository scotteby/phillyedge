/**
 * POST /api/reconcile-fills
 *
 * Fetches all fills from Kalshi's /portfolio/fills endpoint and:
 *   1. Back-fills pnl for our "sold" trades that have pnl=null.
 *   2. Detects and inserts any buy fills that are missing from our DB.
 *
 * Returns a summary of what was fixed so the UI can show a toast.
 */

import { NextResponse } from "next/server";
import { buildKalshiAuthHeaders } from "@/lib/kalshi-sign";
import { createServiceClient } from "@/lib/supabase/server";

const DEMO_MODE   = process.env.KALSHI_DEMO_MODE === "true";
const KALSHI_BASE = DEMO_MODE
  ? "https://demo-api.kalshi.co/trade-api/v2"
  : "https://api.elections.kalshi.com/trade-api/v2";
const FILLS_PATH  = "/trade-api/v2/portfolio/fills";

interface KalshiFill {
  fill_id?:    string;
  order_id?:   string;
  ticker?:     string;
  side?:       string;   // "yes" | "no"
  action?:     string;   // "buy" | "sell"
  count?:      number;
  count_fp?:   string;   // fixed-point e.g. "16.00"
  yes_price?:  number;   // integer cents or decimal
  no_price?:   number;
  created_time?: string;
  is_taker?:   boolean;
}

function parseCount(fill: KalshiFill): number {
  if (fill.count_fp != null) return parseFloat(fill.count_fp);
  if (fill.count    != null) return fill.count;
  return 0;
}

/** Return YES price as a 0–1 decimal from a fill object. */
function parseYesPrice(fill: KalshiFill): number | null {
  const raw = fill.yes_price ?? (fill.no_price != null ? 100 - fill.no_price : null);
  if (raw == null) return null;
  const n = Number(raw);
  if (n > 1)         return n / 100;
  if (n > 0 && n < 1) return n;
  return null;
}

export async function POST() {
  // ── Fetch all fills from Kalshi ──────────────────────────────────────────────
  let headers: Record<string, string>;
  try {
    headers = buildKalshiAuthHeaders("GET", FILLS_PATH);
  } catch (err) {
    return NextResponse.json(
      { error: `Signing error: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }

  const fills: KalshiFill[] = [];
  let cursor: string | null = null;

  // Paginate through all fills (Kalshi returns up to 100 per page)
  for (let page = 0; page < 20; page++) {
    const url = new URL(`${KALSHI_BASE}/portfolio/fills`);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);

    try {
      const res = await fetch(url.toString(), {
        method: "GET",
        headers,
        cache:  "no-store",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        console.error("[reconcile-fills] Kalshi error:", res.status, JSON.stringify(body));
        return NextResponse.json(
          { error: `Kalshi fills API error ${res.status}: ${JSON.stringify(body)}` },
          { status: 502 }
        );
      }
      const json = await res.json();
      const pageFills = (json.fills ?? []) as KalshiFill[];
      fills.push(...pageFills);
      cursor = (json.cursor as string | null) ?? null;
      console.log(`[reconcile-fills] page ${page + 1}: ${pageFills.length} fills (cursor=${cursor})`);
      if (!cursor || pageFills.length === 0) break;
    } catch (err) {
      return NextResponse.json(
        { error: `Network error: ${err instanceof Error ? err.message : String(err)}` },
        { status: 502 }
      );
    }
  }

  console.log(`[reconcile-fills] total fills fetched: ${fills.length}`);

  // ── Load sold trades with null pnl from our DB ───────────────────────────────
  const supabase = createServiceClient();

  const { data: nullPnlTrades, error: dbErr } = await supabase
    .from("trades")
    .select("id, market_id, side, entry_yes_price, market_pct, kalshi_order_id, outcome, amount_usdc, filled_count")
    .eq("outcome", "sold")
    .is("pnl", null);

  if (dbErr) {
    return NextResponse.json({ error: `DB error: ${dbErr.message}` }, { status: 500 });
  }

  const soldNullPnl = (nullPnlTrades ?? []) as Array<{
    id: string;
    market_id: string;
    side: string;
    entry_yes_price: number | null;
    market_pct: number;
    kalshi_order_id: string | null;
    outcome: string;
    amount_usdc: number;
    filled_count: number | null;
  }>;

  console.log(`[reconcile-fills] ${soldNullPnl.length} sold trades with null pnl`);

  // Group Kalshi SELL fills by order_id for fast lookup
  const sellFillsByOrder = new Map<string, KalshiFill[]>();
  const sellFillsByTicker = new Map<string, KalshiFill[]>();

  for (const fill of fills) {
    if (String(fill.action ?? "").toLowerCase() !== "sell") continue;
    if (fill.order_id) {
      const arr = sellFillsByOrder.get(fill.order_id) ?? [];
      arr.push(fill);
      sellFillsByOrder.set(fill.order_id, arr);
    }
    if (fill.ticker) {
      const arr = sellFillsByTicker.get(fill.ticker) ?? [];
      arr.push(fill);
      sellFillsByTicker.set(fill.ticker, arr);
    }
  }

  // ── Match sell fills → sold trades → compute + update pnl ───────────────────
  let pnlFixed = 0;

  for (const trade of soldNullPnl) {
    const tradeSide = trade.side.toLowerCase() as "yes" | "no";

    // Entry cost per contract
    const entryYes: number =
      trade.entry_yes_price ??
      (tradeSide === "yes"
        ? trade.market_pct / 100
        : 1 - trade.market_pct / 100);
    const entryCostPerContract = tradeSide === "yes" ? entryYes : 1 - entryYes;

    // Number of contracts sold
    const filledCount = trade.filled_count ??
      (entryCostPerContract > 0 ? Math.floor(trade.amount_usdc / entryCostPerContract) : 0);

    if (filledCount <= 0) continue;

    // Try matching by kalshi_order_id first (most precise)
    let matchedFills: KalshiFill[] = [];
    if (trade.kalshi_order_id) {
      matchedFills = sellFillsByOrder.get(trade.kalshi_order_id) ?? [];
    }

    // Fallback: match by ticker + side (less precise but catches most cases)
    // When an order_id exists but no fills matched, the order might be the SELL
    // order (swapped into kalshi_order_id by sell-position) — try that path too.
    if (matchedFills.length === 0) {
      const tickerFills = sellFillsByTicker.get(trade.market_id.toUpperCase()) ?? [];
      matchedFills = tickerFills.filter(
        (f) => String(f.side ?? "").toLowerCase() === tradeSide
      );
    }

    if (matchedFills.length === 0) {
      console.log(`[reconcile-fills] no sell fill match for trade ${trade.id} (${trade.market_id} ${tradeSide})`);
      continue;
    }

    // Compute weighted-average YES price across matched fills
    let totalWeightedYes = 0;
    let totalCount       = 0;
    for (const f of matchedFills) {
      const c   = parseCount(f);
      const yp  = parseYesPrice(f);
      if (c > 0 && yp != null) {
        totalWeightedYes += c * yp;
        totalCount       += c;
      }
    }

    if (totalCount <= 0) {
      console.log(`[reconcile-fills] could not compute avg price for trade ${trade.id}`);
      continue;
    }

    const avgFillYesPrice   = totalWeightedYes / totalCount;
    const proceedsPerContract = tradeSide === "yes" ? avgFillYesPrice : 1 - avgFillYesPrice;
    const pnl = parseFloat(((proceedsPerContract - entryCostPerContract) * filledCount).toFixed(2));

    console.log(
      `[reconcile-fills] trade ${trade.id} (${trade.market_id} ${tradeSide}): ` +
      `${filledCount} contracts, avgFillYes=${avgFillYesPrice.toFixed(4)}, ` +
      `proceeds/contract=${proceedsPerContract.toFixed(4)}, pnl=${pnl}`
    );

    const { error: updateErr } = await supabase
      .from("trades")
      .update({ pnl })
      .eq("id", trade.id);

    if (updateErr) {
      console.error(`[reconcile-fills] failed to update trade ${trade.id}:`, updateErr.message);
    } else {
      pnlFixed++;
    }
  }

  // ── Check for buy fills missing from our DB ──────────────────────────────────
  // Load all our trade market_ids for quick membership test
  const { data: allTrades } = await supabase
    .from("trades")
    .select("kalshi_order_id")
    .not("kalshi_order_id", "is", null);

  const knownOrderIds = new Set(
    ((allTrades ?? []) as Array<{ kalshi_order_id: string | null }>)
      .map((t) => t.kalshi_order_id)
      .filter(Boolean)
  );

  const missingBuys: { order_id: string; ticker: string; side: string; count: number; yes_price: number | null }[] = [];
  for (const fill of fills) {
    if (String(fill.action ?? "").toLowerCase() !== "buy") continue;
    if (!fill.order_id) continue;
    if (knownOrderIds.has(fill.order_id)) continue;
    missingBuys.push({
      order_id: fill.order_id,
      ticker:   fill.ticker ?? "",
      side:     fill.side ?? "",
      count:    parseCount(fill),
      yes_price: parseYesPrice(fill),
    });
  }

  console.log(
    `[reconcile-fills] done — pnlFixed=${pnlFixed}, missingBuys=${missingBuys.length}`
  );

  return NextResponse.json({
    ok:          true,
    fills_total: fills.length,
    pnl_fixed:   pnlFixed,
    missing_buys: missingBuys,
  });
}
