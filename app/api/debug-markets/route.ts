/**
 * GET /api/debug-markets
 * Bypasses cache — directly hits Kalshi and the DB to diagnose empty market issues.
 * Remove or gate this endpoint once you've diagnosed the problem.
 */

import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

const DEMO_MODE   = process.env.KALSHI_DEMO_MODE === "true";
const KALSHI_BASE = DEMO_MODE
  ? "https://demo-api.kalshi.co/trade-api/v2"
  : "https://api.elections.kalshi.com/trade-api/v2";

const PHILLY_SERIES = ["KXHIGHPHIL", "KXLOWTPHIL", "KXPRECIPPHIL"];

export async function GET() {
  const supabase = createServiceClient();

  // 1. DB state
  const { data: allRows } = await supabase
    .from("market_cache")
    .select("market_id, end_date, active, fetched_at")
    .order("fetched_at", { ascending: false })
    .limit(30);

  const { data: activeRows } = await supabase
    .from("market_cache")
    .select("market_id, end_date, active, fetched_at")
    .eq("active", true)
    .limit(30);

  // 2. Raw Kalshi hits
  const kalshiResults: Record<string, unknown> = {};
  for (const series of PHILLY_SERIES) {
    try {
      const res = await fetch(
        `${KALSHI_BASE}/markets?series_ticker=${series}&status=open`,
        { headers: { Accept: "application/json" }, cache: "no-store" }
      );
      const json = await res.json();
      kalshiResults[series] = {
        http_status: res.status,
        market_count: (json.markets ?? []).length,
        tickers: (json.markets ?? []).map((m: { ticker: string }) => m.ticker),
        raw_sample: (json.markets ?? []).slice(0, 2),
      };
    } catch (err) {
      kalshiResults[series] = { error: String(err) };
    }
  }

  // 3. Fallback scan
  let fallbackCount = 0;
  let fallbackTickers: string[] = [];
  try {
    const res = await fetch(
      `${KALSHI_BASE}/markets?status=open&limit=200`,
      { headers: { Accept: "application/json" }, cache: "no-store" }
    );
    const json = await res.json();
    const all: { ticker: string }[] = json.markets ?? [];
    fallbackCount = all.length;
    fallbackTickers = all
      .filter((m) => {
        const t = m.ticker.toLowerCase();
        return (t.startsWith("kxhigh") || t.startsWith("kxlowt") || t.startsWith("kxprecip")) && t.includes("phil");
      })
      .map((m) => m.ticker);
  } catch (err) {
    fallbackTickers = [`error: ${String(err)}`];
  }

  return NextResponse.json({
    demo_mode: DEMO_MODE,
    kalshi_base: KALSHI_BASE,
    db: {
      total_rows: allRows?.length ?? 0,
      active_rows: activeRows?.length ?? 0,
      rows: allRows,
    },
    kalshi_series_fetch: kalshiResults,
    fallback_scan: {
      total_open_markets: fallbackCount,
      philly_matches: fallbackTickers,
    },
  });
}
