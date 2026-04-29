import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createServiceClient();

  // 1. Raw Kalshi response for KXHIGHPHIL
  let kalshiRaw: unknown = null;
  try {
    const res = await fetch(
      "https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXHIGHPHIL&status=open",
      { headers: { Accept: "application/json" }, cache: "no-store" }
    );
    const json = await res.json();
    // Return first market object in full so we can see all field names
    kalshiRaw = { status: res.status, first_market: json.markets?.[0] ?? null, total: json.markets?.length ?? 0 };
  } catch (e) {
    kalshiRaw = { error: String(e) };
  }

  // 2. market_cache rows
  const { data: cacheRows } = await supabase
    .from("market_cache")
    .select("market_id, end_date, yes_price, volume, fetched_at, active")
    .order("fetched_at", { ascending: false })
    .limit(10);

  // 3. Forecasts from today onwards
  const today = new Date().toISOString().split("T")[0];
  const { data: forecasts } = await supabase
    .from("forecasts")
    .select("forecast_date, day_index, target_date, high_temp, low_temp, precip_chance")
    .gte("target_date", today)
    .order("forecast_date", { ascending: false })
    .limit(14);

  return NextResponse.json({ kalshiRaw, cacheRows, forecasts, today });
}
