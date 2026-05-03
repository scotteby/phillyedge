import { createServiceClient } from "@/lib/supabase/server";
import type { Forecast, Trade } from "@/lib/types";
import { forecastPctForMarket } from "@/lib/brackets";
import HistoryClient from "./HistoryClient";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const supabase = createServiceClient();

  // Fetch trades and recent forecasts in parallel
  const [{ data: tradesData }, { data: forecastsData }] = await Promise.all([
    supabase.from("trades").select("*").order("created_at", { ascending: false }),
    supabase.from("forecasts").select("*").order("forecast_date", { ascending: false }),
  ]);

  const trades    = (tradesData    as Trade[]    | null) ?? [];
  const forecasts = (forecastsData as Forecast[] | null) ?? [];

  // Pre-compute our model's forecast probability for every trade's bracket.
  // Keyed by market_id so HistoryClient can look up values instantly.
  const forecastPcts: Record<string, number> = {};
  for (const t of trades) {
    if (t.market_id in forecastPcts) continue; // already computed
    const pct = forecastPctForMarket(t.market_id, t.market_question, forecasts);
    if (pct != null) forecastPcts[t.market_id] = pct;
  }

  return <HistoryClient initialTrades={trades} forecastPcts={forecastPcts} />;
}
