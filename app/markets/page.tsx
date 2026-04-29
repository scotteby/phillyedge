import { createServiceClient } from "@/lib/supabase/server";
import { fetchAndCacheMarkets } from "@/lib/kalshi";
import { calculateEdge, deduplicateByEvent } from "@/lib/edge";
import { groupBracketMarkets } from "@/lib/brackets";
import { fetchNWSObservation, fetchCurrentObservation, observationTimeGates, todayMarketTimeGates, getDailyHighStatus } from "@/lib/nws";
import type { MarketTimeGates, CurrentObservation, DailyHighStatus } from "@/lib/nws";
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

  // Fetch markets + NWS observations in parallel.
  // NWSObservation is always fetched (not gated) so we can show the running
  // daily high/low at any time of day.  The gates only control whether we treat
  // the observed value as *confirmed* (setting group.observed_value).
  const gates     = observationTimeGates();
  const timeGates = todayMarketTimeGates();
  const [{ data: marketsData, lastUpdated, rawCount }, nwsObs, currentObs] = await Promise.all([
    fetchAndCacheMarkets(),
    fetchNWSObservation(),
    fetchCurrentObservation(),
  ]);
  const allMarkets = (marketsData as MarketCache[] | null) ?? [];

  const observed = {
    low:  gates.useLow  ? (nwsObs?.observedLow  ?? null) : null,
    high: gates.useHigh ? (nwsObs?.observedHigh ?? null) : null,
  };

  // Split bracket groups from single binary markets
  const { groups, singles } = groupBracketMarkets(allMarkets, deduped, observed);

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

  const highObsStatus: DailyHighStatus = getDailyHighStatus(nwsObs);

  return (
    <MarketsClient
      groups={groups}
      markets={singleWithEdge}
      lastUpdatedLabel={lastUpdatedLabel}
      rawCount={rawCount}
      today={today}
      timeGates={timeGates}
      currentObs={currentObs}
      nwsHighSoFar={nwsObs?.observedHigh ?? null}
      nwsHighReachedAt={nwsObs?.highReachedAt ?? null}
      highObsStatus={highObsStatus}
    />
  );
}
