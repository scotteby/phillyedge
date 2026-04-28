"use client";

import { useState } from "react";
import type { Trade } from "@/lib/types";
import SignalBadge from "@/components/SignalBadge";

interface Props {
  initialTrades: Trade[];
}

export default function HistoryClient({ initialTrades }: Props) {
  const [trades, setTrades] = useState<Trade[]>(initialTrades);
  const [updating, setUpdating] = useState<string | null>(null);

  // Summary stats
  const total = trades.length;
  const settled = trades.filter((t) => t.outcome !== "pending");
  const wins = trades.filter((t) => t.outcome === "win").length;
  const winRate = settled.length > 0 ? Math.round((wins / settled.length) * 100) : null;
  const totalPnl = trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const avgEdge = total > 0 ? Math.round(trades.reduce((s, t) => s + t.edge, 0) / total) : 0;

  async function updateOutcome(
    tradeId: string,
    outcome: Trade["outcome"],
    amountUsdc: number,
    side: "YES" | "NO",
    marketPct: number
  ) {
    setUpdating(tradeId);

    // Auto-calc P&L: win = amount * (100/marketPct - 1), loss = -amount
    let pnl: number | null = null;
    if (outcome === "win") {
      pnl = marketPct > 0 ? parseFloat((amountUsdc * (100 / marketPct - 1)).toFixed(2)) : null;
    } else if (outcome === "loss") {
      pnl = -amountUsdc;
    }

    try {
      const res = await fetch("/api/trades", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: tradeId, outcome, pnl }),
      });
      const json = await res.json();
      if (res.ok && json.data) {
        setTrades((prev) =>
          prev.map((t) => (t.id === tradeId ? json.data : t))
        );
      }
    } finally {
      setUpdating(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <h1 className="text-2xl font-bold text-white">Trade History</h1>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <SummaryCard label="Total Trades" value={String(total)} />
        <SummaryCard
          label="Win Rate"
          value={winRate !== null ? `${winRate}%` : "—"}
          sub={settled.length > 0 ? `${wins}/${settled.length} settled` : "No settled trades"}
        />
        <SummaryCard
          label="Total P&L"
          value={totalPnl !== 0 ? `${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}` : "$0.00"}
          valueClass={totalPnl > 0 ? "text-emerald-400" : totalPnl < 0 ? "text-red-400" : "text-white"}
        />
        <SummaryCard label="Avg Edge" value={`${avgEdge > 0 ? "+" : ""}${avgEdge} pts`} />
      </div>

      {/* Table */}
      {trades.length === 0 ? (
        <div className="text-center py-20 text-slate-500">
          <p className="text-4xl mb-3">📊</p>
          <p className="text-lg font-medium">No trades logged yet</p>
          <p className="text-sm mt-1">Head to Markets to find edges and log your first trade.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 uppercase tracking-wider border-b border-slate-700">
                <th className="pb-3 pr-4">Date</th>
                <th className="pb-3 pr-4">Market</th>
                <th className="pb-3 pr-4">Side</th>
                <th className="pb-3 pr-4">Amount</th>
                <th className="pb-3 pr-4">Signal</th>
                <th className="pb-3 pr-4">Edge</th>
                <th className="pb-3 pr-4">Outcome</th>
                <th className="pb-3">P&L</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50">
              {trades.map((trade) => (
                <TradeRow
                  key={trade.id}
                  trade={trade}
                  updating={updating === trade.id}
                  onUpdateOutcome={(outcome) =>
                    updateOutcome(trade.id, outcome, trade.amount_usdc, trade.side, trade.market_pct)
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  sub,
  valueClass = "text-white",
}: {
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
}) {
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
      <p className="text-xs text-slate-500 uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${valueClass}`}>{value}</p>
      {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}

function TradeRow({
  trade,
  updating,
  onUpdateOutcome,
}: {
  trade: Trade;
  updating: boolean;
  onUpdateOutcome: (outcome: Trade["outcome"]) => void;
}) {
  const edgeColor =
    trade.edge >= 25
      ? "text-emerald-400"
      : trade.edge >= 10
      ? "text-sky-400"
      : trade.edge <= -10
      ? "text-red-400"
      : "text-slate-400";

  const pnlColor = trade.pnl == null ? "" : trade.pnl >= 0 ? "text-emerald-400" : "text-red-400";

  return (
    <tr className="hover:bg-slate-800/50 transition-colors">
      <td className="py-3 pr-4 text-slate-400 whitespace-nowrap">
        {new Date(trade.created_at).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        })}
      </td>
      <td className="py-3 pr-4 max-w-[200px]">
        <a
          href={trade.polymarket_url ?? "#"}
          target="_blank"
          rel="noopener noreferrer"
          className="text-slate-200 hover:text-sky-400 transition-colors line-clamp-2 leading-snug"
        >
          {trade.market_question}
        </a>
      </td>
      <td className="py-3 pr-4">
        <span
          className={`font-semibold ${
            trade.side === "YES" ? "text-emerald-400" : "text-red-400"
          }`}
        >
          {trade.side}
        </span>
      </td>
      <td className="py-3 pr-4 text-slate-200 whitespace-nowrap">
        ${trade.amount_usdc.toFixed(2)}
      </td>
      <td className="py-3 pr-4">
        <SignalBadge signal={trade.signal} />
      </td>
      <td className={`py-3 pr-4 font-semibold ${edgeColor} whitespace-nowrap`}>
        {trade.edge > 0 ? "+" : ""}{trade.edge}
      </td>
      <td className="py-3 pr-4">
        <select
          value={trade.outcome}
          disabled={updating}
          onChange={(e) => onUpdateOutcome(e.target.value as Trade["outcome"])}
          className="bg-slate-700 border border-slate-600 rounded-lg px-2 py-1 text-sm text-white focus:outline-none focus:ring-2 focus:ring-sky-500 disabled:opacity-50"
        >
          <option value="pending">Pending</option>
          <option value="win">Win</option>
          <option value="loss">Loss</option>
        </select>
      </td>
      <td className={`py-3 font-semibold whitespace-nowrap ${pnlColor}`}>
        {trade.pnl != null
          ? `${trade.pnl >= 0 ? "+" : ""}$${trade.pnl.toFixed(2)}`
          : "—"}
      </td>
    </tr>
  );
}
