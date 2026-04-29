import { createServiceClient } from "@/lib/supabase/server";
import { fetchAndCacheMarkets } from "@/lib/kalshi";
import { calculateEdge, deduplicateByEvent } from "@/lib/edge";
import { groupBracketMarkets } from "@/lib/brackets";
import type { Forecast, MarketCache } from "@/lib/types";
import MarketsClient from "./MarketsClient";
import Link from "next/link";

export const dynamic = "force-dynamic";

function toISODate(d: Date): string {
  return d.toISOString().split("T")[0];
}

export default async function MarketsPage() {
  const supabase = createServiceClient();

  // Load recent forecasts
  const today = toISODate(new Date());
  const { data: forecastsData } = await supabase
    .from("forecasts")
    .select("*")
    .gte("target_date", today)
    .order("forecast_date", { ascending: false });

  const forecasts = (forecastsData as Forecast[] | null) ?? [];

  // De-duplicate: latest forecast_date per target_date
  const latestPerTarget = new Map<string, Forecast>();
  for (const f of forecasts) {
    const existing = latestPerTarget.get(f.target_date);
    if (!existing || f.forecast_date > existing.forecast_date) {
      latestPerTarget.set(f.target_date, f);
    }
  }
  const deduped = Array.from(latestPerTarget.values());

  if (deduped.length === 0) {
    return (
      <div className="text-center py-20">
        <p className="text-4xl mb-4">📋</p>
        <h2 className="text-xl font-bold text-white mb-2">No forecast for today</h2>
        <p className="text-slate-400 text-sm mb-6">
          Enter your 7-day forecast to see edge calculations against live Kalshi prices.
        </p>
        <Link href="/forecast"
          className="inline-block bg-sky-500 hover:bg-sky-400 text-white font-semibold px-6 py-2.5 rounded-xl transition-colors">
          Enter Forecast →
        </Link>
      </div>
    );
  }

  // Fetch markets
  const { data: marketsData, lastUpdated, rawCount } = await fetchAndCacheMarkets();
  const allMarkets = (marketsData as MarketCache[] | null) ?? [];

  // Split bracket groups from single binary markets
  const { groups, singles } = groupBracketMarkets(allMarkets, deduped);

  // Edge-calculate single markets (deduplicated)
  const singleWithEdge = deduplicateByEvent(
    singles.map((m) => calculateEdge(m, deduped))
  );

  const lastUpdatedLabel = lastUpdated
    ? new Date(lastUpdated).toLocaleString("en-US", {
        month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit",
        timeZone: "America/New_York",
      })
    : null;

  return (
    <MarketsClient
      groups={groups}
      markets={singleWithEdge}
      lastUpdatedLabel={lastUpdatedLabel}
      rawCount={rawCount}
    />
  );
}
