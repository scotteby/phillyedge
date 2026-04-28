"use client";

import { useState } from "react";
import type { MarketWithEdge } from "@/lib/types";
import SignalBadge from "@/components/SignalBadge";
import TradeModal from "./TradeModal";

type Filter = "all" | "strong-buy" | "buy" | "avoid";

interface Props {
  markets: MarketWithEdge[];
  lastUpdated: string | null;
  rawCount?: number;
}

export default function MarketsClient({ markets, lastUpdated, rawCount }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedMarket, setSelectedMarket] = useState<MarketWithEdge | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const filtered =
    filter === "all" ? markets : markets.filter((m) => m.signal === filter);

  const sorted = [...filtered].sort(
    (a, b) => Math.abs(b.edge) - Math.abs(a.edge)
  );

  async function handleRefresh() {
    setRefreshing(true);
    // Force cache bust by calling the API directly
    await fetch("/api/markets");
    window.location.reload();
  }

  const filterButtons: { value: Filter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "strong-buy", label: "Strong Buy" },
    { value: "buy", label: "Buy" },
    { value: "avoid", label: "Avoid" },
  ];

  return (
    <>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Markets</h1>
          {lastUpdated && (
            <p className="text-slate-400 text-sm mt-0.5">
              Markets last updated:{" "}
              {new Date(lastUpdated).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
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
              <span className="ml-1.5 text-xs opacity-70">
                ({markets.filter((m) => m.signal === value).length})
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Empty state */}
      {sorted.length === 0 && (
        <div className="text-center py-20 text-slate-500">
          <p className="text-4xl mb-3">🌤</p>
          <p className="text-lg font-medium text-slate-300">No markets found</p>
          {filter !== "all" ? (
            <p className="text-sm mt-1">No {filter} signals right now — try the All tab.</p>
          ) : (
            <div className="text-sm mt-2 space-y-1">
              <p>No Philadelphia weather markets matched in the Polymarket feed.</p>
              {rawCount !== undefined && rawCount > 0 && (
                <p className="text-xs text-slate-600">
                  ({rawCount.toLocaleString()} total markets scanned)
                </p>
              )}
              {rawCount === 0 && (
                <p className="text-xs text-slate-600">
                  Could not reach the Polymarket API — check your network or try refreshing.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Market cards */}
      <div className="space-y-4">
        {sorted.map((market) => (
          <MarketCard
            key={market.id}
            market={market}
            onTrade={() => setSelectedMarket(market)}
          />
        ))}
      </div>

      {/* Trade modal */}
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

function MarketCard({
  market,
  onTrade,
}: {
  market: MarketWithEdge;
  onTrade: () => void;
}) {
  const edgeColor =
    market.edge >= 25
      ? "text-emerald-400"
      : market.edge >= 10
      ? "text-sky-400"
      : market.edge <= -10
      ? "text-red-400"
      : "text-slate-400";

  const volumeK =
    market.volume >= 1000
      ? `$${(market.volume / 1000).toFixed(1)}K`
      : `$${market.volume}`;

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
      <div className="flex items-start gap-4">
        {/* Main content */}
        <div className="flex-1 min-w-0">
          <p className="text-white font-medium leading-snug">{market.question}</p>
          <p className="text-slate-500 text-xs mt-1">
            Closes {new Date(market.end_date).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </p>

          {/* Stats row */}
          <div className="flex flex-wrap gap-4 mt-3">
            <Stat label="Market" value={`${market.market_pct}%`} />
            <Stat label="Our Forecast" value={`${market.my_pct}%`} />
            <Stat
              label="Edge"
              value={`${market.edge > 0 ? "+" : ""}${market.edge} pts`}
              valueClass={edgeColor}
            />
            <Stat label="Volume" value={volumeK} />
          </div>
        </div>

        {/* Right column */}
        <div className="flex flex-col items-end gap-3 shrink-0">
          <SignalBadge signal={market.signal} />
          <button
            onClick={onTrade}
            className="px-4 py-2 bg-sky-500 hover:bg-sky-400 text-white text-sm font-semibold rounded-lg transition-colors"
          >
            Trade
          </button>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  valueClass = "text-white",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`text-sm font-semibold ${valueClass}`}>{value}</p>
    </div>
  );
}
