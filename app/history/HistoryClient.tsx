"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { Trade, OrderStatus } from "@/lib/types";
import SignalBadge from "@/components/SignalBadge";

interface Props {
  initialTrades: Trade[];
}

// ── Toast ─────────────────────────────────────────────────────────────────────

interface Toast {
  id: number;
  message: string;
  type: "fill" | "cancel" | "error";
}

let toastCounter = 0;

function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((message: string, type: Toast["type"] = "fill") => {
    const id = ++toastCounter;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4500);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, addToast, dismiss };
}

// ── Order status helpers ──────────────────────────────────────────────────────

function isActiveOrder(trade: Trade): boolean {
  // Poll if we have a Kalshi order ID and status hasn't settled
  if (!trade.kalshi_order_id) return false;
  const s = trade.order_status;
  return s === "resting" || s === "partially_filled" || s === null;
}

function OrderStatusBadge({ status }: { status: OrderStatus }) {
  if (status === null) return null;

  const map: Record<NonNullable<OrderStatus>, { label: string; classes: string }> = {
    resting:          { label: "🟡 Resting",   classes: "bg-yellow-500/15 text-yellow-300 border-yellow-500/30" },
    partially_filled: { label: "🟠 Partial",   classes: "bg-orange-500/15 text-orange-300 border-orange-500/30" },
    filled:           { label: "🟢 Filled",    classes: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
    canceled:         { label: "🔴 Cancelled", classes: "bg-red-500/15 text-red-300 border-red-500/30" },
    expired:          { label: "⚫ Expired",   classes: "bg-slate-500/20 text-slate-400 border-slate-500/30" },
  };

  const { label, classes } = map[status];
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${classes}`}>
      {label}
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function HistoryClient({ initialTrades }: Props) {
  const [trades, setTrades]   = useState<Trade[]>(initialTrades);
  const [updating, setUpdating] = useState<string | null>(null);
  const [canceling, setCanceling] = useState<string | null>(null);
  const { toasts, addToast, dismiss } = useToasts();

  // Keep a ref to latest trades so the polling callback sees current data
  const tradesRef = useRef(trades);
  useEffect(() => { tradesRef.current = trades; }, [trades]);

  // ── Order status polling ─────────────────────────────────────────────────

  const pollOrder = useCallback(async (tradeId: string) => {
    try {
      const res  = await fetch(`/api/order-status?trade_id=${tradeId}`);
      if (!res.ok) return;
      const json = await res.json() as {
        order_status: OrderStatus;
        filled_count: number;
        remaining_count: number;
        last_checked_at: string;
      };

      setTrades((prev) => {
        const old = prev.find((t) => t.id === tradeId);
        const updated = prev.map((t) =>
          t.id === tradeId
            ? { ...t, ...json }
            : t
        );

        // Fire toast on transition to filled / partially_filled
        if (old && old.order_status !== json.order_status) {
          if (json.order_status === "filled") {
            const t = updated.find((x) => x.id === tradeId);
            addToast(`✅ Order filled — ${t?.market_question ?? tradeId}`, "fill");
          } else if (json.order_status === "partially_filled") {
            const t = updated.find((x) => x.id === tradeId);
            addToast(`🟠 Partial fill — ${t?.market_question ?? tradeId} (${json.filled_count} filled)`, "fill");
          }
        }

        return updated;
      });
    } catch {
      // silently ignore network errors in polling
    }
  }, [addToast]);

  // On mount and every 60 s, poll all active orders
  useEffect(() => {
    function pollAll() {
      tradesRef.current
        .filter(isActiveOrder)
        .forEach((t) => pollOrder(t.id));
    }

    // Immediate first poll
    pollAll();

    const interval = setInterval(pollAll, 60_000);
    return () => clearInterval(interval);
  }, [pollOrder]);

  // ── Outcome update ───────────────────────────────────────────────────────

  async function updateOutcome(
    tradeId: string,
    outcome: Trade["outcome"],
    amountUsdc: number,
    marketPct: number
  ) {
    setUpdating(tradeId);

    let pnl: number | null = null;
    if (outcome === "win") {
      pnl = marketPct > 0 ? parseFloat((amountUsdc * (100 / marketPct - 1)).toFixed(2)) : null;
    } else if (outcome === "loss") {
      pnl = -amountUsdc;
    }

    try {
      const res  = await fetch("/api/trades", {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ id: tradeId, outcome, pnl }),
      });
      const json = await res.json();
      if (res.ok && json.data) {
        setTrades((prev) => prev.map((t) => (t.id === tradeId ? json.data : t)));
      }
    } finally {
      setUpdating(null);
    }
  }

  // ── Cancel order ─────────────────────────────────────────────────────────

  async function cancelOrder(tradeId: string) {
    if (!confirm("Cancel this order on Kalshi?")) return;
    setCanceling(tradeId);

    try {
      const res  = await fetch("/api/cancel-order", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ trade_id: tradeId }),
      });
      const json = await res.json();

      if (res.ok) {
        setTrades((prev) =>
          prev.map((t) =>
            t.id === tradeId ? { ...t, order_status: "canceled" as OrderStatus } : t
          )
        );
        addToast("Order cancelled.", "cancel");
      } else {
        addToast(`Cancel failed: ${json.error ?? "unknown error"}`, "error");
      }
    } catch (err) {
      addToast(`Cancel error: ${String(err)}`, "error");
    } finally {
      setCanceling(null);
    }
  }

  // ── Summary stats ─────────────────────────────────────────────────────────

  const total   = trades.length;
  const settled = trades.filter((t) => t.outcome !== "pending");
  const wins    = trades.filter((t) => t.outcome === "win").length;
  const winRate = settled.length > 0 ? Math.round((wins / settled.length) * 100) : null;
  const totalPnl = trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const avgEdge  = total > 0 ? Math.round(trades.reduce((s, t) => s + t.edge, 0) / total) : 0;

  return (
    <div className="space-y-6">
      {/* Toasts */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            onClick={() => dismiss(toast.id)}
            className={`
              pointer-events-auto px-4 py-3 rounded-xl shadow-xl text-sm font-medium
              border backdrop-blur-sm cursor-pointer transition-all
              ${toast.type === "fill"   ? "bg-emerald-900/90 border-emerald-500/40 text-emerald-200" : ""}
              ${toast.type === "cancel" ? "bg-slate-800/90 border-slate-600/40 text-slate-300" : ""}
              ${toast.type === "error"  ? "bg-red-900/90 border-red-500/40 text-red-200" : ""}
            `}
          >
            {toast.message}
          </div>
        ))}
      </div>

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
                <th className="pb-3 pr-4">Order Status</th>
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
                  canceling={canceling === trade.id}
                  onUpdateOutcome={(outcome) =>
                    updateOutcome(trade.id, outcome, trade.amount_usdc, trade.market_pct)
                  }
                  onCancel={() => cancelOrder(trade.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

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
  canceling,
  onUpdateOutcome,
  onCancel,
}: {
  trade: Trade;
  updating: boolean;
  canceling: boolean;
  onUpdateOutcome: (outcome: Trade["outcome"]) => void;
  onCancel: () => void;
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

  const showCancel =
    trade.kalshi_order_id &&
    (trade.order_status === "resting" || trade.order_status === "partially_filled" || trade.order_status === null);

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
        <span className={`font-semibold ${trade.side === "YES" ? "text-emerald-400" : "text-red-400"}`}>
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
      {/* Order status column */}
      <td className="py-3 pr-4">
        <div className="flex flex-col gap-1.5 items-start">
          {trade.kalshi_order_id ? (
            <>
              <OrderStatusBadge status={trade.order_status} />
              {trade.order_status === "partially_filled" && trade.filled_count != null && (
                <span className="text-xs text-slate-500">
                  {trade.filled_count} filled / {trade.remaining_count} left
                </span>
              )}
              {showCancel && (
                <button
                  onClick={onCancel}
                  disabled={canceling}
                  className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50 transition-colors"
                >
                  {canceling ? "Canceling…" : "Cancel order"}
                </button>
              )}
            </>
          ) : (
            <span className="text-xs text-slate-600">—</span>
          )}
        </div>
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
