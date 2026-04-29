"use client";

import { useState } from "react";
import type { MarketWithEdge } from "@/lib/types";
import type { BracketGroup } from "@/lib/brackets";
import type { MarketTimeGates, MarketTimeStatus, CurrentObservation, DailyHighStatus } from "@/lib/nws";
import SignalBadge from "@/components/SignalBadge";
import TradeModal from "./TradeModal";
import BracketGroupCard from "./BracketGroupCard";

type Filter = "all" | "strong-buy" | "buy" | "avoid";

interface Props {
  groups:           BracketGroup[];
  markets:          MarketWithEdge[];
  lastUpdatedLabel: string | null;
  rawCount?:        number;
  today:            string;
  timeGates:        MarketTimeGates;
  currentObs:       CurrentObservation | null;
  nwsHighSoFar:     number | null;       // running daily max since midnight (KXHIGHPHIL)
  nwsHighReachedAt: string | null;       // when that max was first established
  highObsStatus:    DailyHighStatus;     // monitoring / leading / likely-final
}

export default function MarketsClient({ groups, markets, lastUpdatedLabel, rawCount, today, timeGates, currentObs, nwsHighSoFar, nwsHighReachedAt, highObsStatus }: Props) {
  function groupTimeStatus(_g: BracketGroup): MarketTimeStatus {
    // Never lock an open market — trades are always allowed regardless of time of day.
    return "active";
  }
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedMarket, setSelectedMarket] = useState<MarketWithEdge | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function handleRefresh() {
    setRefreshing(true);
    await fetch("/api/markets?bust=true");
    window.location.reload();
  }

  // Filter single markets
  const filteredSingles =
    filter === "all" ? markets : markets.filter((m) => m.signal === filter);
  const sortedSingles = [...filteredSingles].sort(
    (a, b) => Math.abs(b.edge) - Math.abs(a.edge)
  );

  // Filter bracket groups by best bracket signal
  const filteredGroups =
    filter === "all"
      ? groups
      : groups.filter((g) => g.best?.signal === filter);

  const totalCount = filteredGroups.length + sortedSingles.length;

  // Counts for filter badges (across both types)
  function countSignal(sig: Filter) {
    if (sig === "all") return groups.length + markets.length;
    const gc = groups.filter((g) => g.best?.signal === sig).length;
    const mc = markets.filter((m) => m.signal === sig).length;
    return gc + mc;
  }

  const filterButtons: { value: Filter; label: string }[] = [
    { value: "all",        label: "All" },
    { value: "strong-buy", label: "Strong Buy" },
    { value: "buy",        label: "Buy" },
    { value: "avoid",      label: "Avoid" },
  ];

  return (
    <>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Markets</h1>
          {lastUpdatedLabel && (
            <p className="text-slate-400 text-sm mt-0.5">
              Markets last updated: {lastUpdatedLabel}
            </p>
          )}
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="text-sm px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors disabled:opacity-50"
        >
          {refreshing ? "Refreshing..." : "↻ Refresh"}
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-2 mb-6 flex-wrap">
        {filterButtons.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => setFilter(value)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium border transition-colors ${
              filter === value
                ? "bg-sky-500 border-sky-500 text-white"
                : "border-slate-600 text-slate-400 hover:text-slate-200 hover:border-slate-500"
            }`}
          >
            {label}
            {value !== "all" && (
              <span className="ml-1.5 text-xs opacity-70">({countSignal(value)})</span>
            )}
          </button>
        ))}
      </div>

      {/* Empty state */}
      {totalCount === 0 && (
        <div className="text-center py-20 text-slate-500">
          <p className="text-4xl mb-3">🌤</p>
          <p className="text-lg font-medium text-slate-300">No markets found</p>
          {filter !== "all" ? (
            <p className="text-sm mt-1">No {filter} signals right now — try the All tab.</p>
          ) : (
            <div className="text-sm mt-2 space-y-1">
              <p>No Philadelphia weather markets found in the Kalshi feed.</p>
              {rawCount !== undefined && rawCount > 0 && (
                <p className="text-xs text-slate-600">({rawCount.toLocaleString()} total markets scanned)</p>
              )}
              {rawCount === 0 && (
                <p className="text-xs text-slate-600">Could not reach the Kalshi API — try refreshing.</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Bracket groups */}
      {filteredGroups.length > 0 && (
        <div className="space-y-4 mb-6">
          {filteredGroups.map((g) => (
            <BracketGroupCard
              key={g.event_key}
              group={g}
              timeStatus={groupTimeStatus(g)}
              currentObsF={g.series === "KXHIGHPHIL" && g.obs_date === today ? (currentObs?.tempF ?? null) : null}
              currentObsAt={g.series === "KXHIGHPHIL" && g.obs_date === today ? (currentObs?.observedAt ?? null) : null}
              highSoFarF={g.series === "KXHIGHPHIL" && g.obs_date === today ? nwsHighSoFar : null}
              highReachedAt={g.series === "KXHIGHPHIL" && g.obs_date === today ? nwsHighReachedAt : null}
              highObsStatus={g.series === "KXHIGHPHIL" && g.obs_date === today ? highObsStatus : "monitoring"}
            />
          ))}
        </div>
      )}

      {/* Single binary markets */}
      {sortedSingles.length > 0 && (
        <>
          {filteredGroups.length > 0 && (
            <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3">
              Other Markets
            </h2>
          )}
          <div className="space-y-4">
            {sortedSingles.map((market) => (
              <MarketCard
                key={market.id}
                market={market}
                onTrade={() => setSelectedMarket(market)}
              />
            ))}
          </div>
        </>
      )}

      {selectedMarket && (
        <TradeModal
          market={selectedMarket}
          onClose={() => setSelectedMarket(null)}
          onConfirm={() => setSelectedMarket(null)}
        />
      )}
    </>
  );
}

// ── Single market card (unchanged) ───────────────────────────────────────────

function MarketCard({ market, onTrade }: { market: MarketWithEdge; onTrade: () => void }) {
  const edgeColor =
    market.edge >= 25 ? "text-emerald-400" :
    market.edge >= 10 ? "text-sky-400" :
    market.edge <= -10 ? "text-red-400" : "text-slate-400";

  const vol = market.volume >= 1000 ? `$${(market.volume / 1000).toFixed(1)}K` : `$${market.volume}`;

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <p className="text-white font-medium leading-snug">{market.question}</p>
          <p className="text-slate-500 text-xs mt-1">
            Closes {new Date(market.end_date + "T12:00:00").toLocaleDateString("en-US", {
              month: "short", day: "numeric", year: "numeric",
            })}
          </p>
          <div className="flex flex-wrap gap-4 mt-3">
            <Stat label="Market"       value={`${market.market_pct}%`} />
            <Stat label="Our Forecast" value={`${market.my_pct}%`} />
            <Stat label="Edge"         value={`${market.edge > 0 ? "+" : ""}${market.edge} pts`} valueClass={edgeColor} />
            <Stat label="Volume"       value={vol} />
          </div>
        </div>
        <div className="flex flex-col items-end gap-3 shrink-0">
          <SignalBadge signal={market.signal} />
          <button onClick={onTrade}
            className="px-4 py-2 bg-sky-500 hover:bg-sky-400 text-white text-sm font-semibold rounded-lg transition-colors">
            Trade
          </button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, valueClass = "text-white" }: { label: string; value: string; valueClass?: string }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`text-sm font-semibold ${valueClass}`}>{value}</p>
    </div>
  );
}
