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

// ── EV helpers ────────────────────────────────────────────────────────────────

/**
 * Entry YES price as 0–1 decimal.
 * Uses stored entry_yes_price when available; falls back to deriving from
 * the integer market_pct that was recorded at trade time.
 */
function getEntryYesPrice(trade: Trade): number {
  if (trade.entry_yes_price != null) return trade.entry_yes_price;
  return trade.side === "YES"
    ? trade.market_pct / 100
    : 1 - trade.market_pct / 100;
}

/**
 * Mark-to-market (unrealized) P&L — what you'd receive if you sold NOW.
 *
 *   contracts    = amount_paid / entry_price
 *   current_value = contracts × live_price
 *   MTM          = current_value − amount_paid
 *                = amount × (live_price / entry_price − 1)
 *
 * Example: YES at 50¢, now 1¢, $5 invested
 *   contracts = 5 / 0.50 = 10
 *   current   = 10 × 0.01 = $0.10
 *   MTM       = $0.10 − $5.00 = −$4.90  ✓
 */
function calcMarkToMarket(trade: Trade, liveYesPrice: number): number {
  const entryYes  = getEntryYesPrice(trade);
  const entryPrice = trade.side === "YES" ? entryYes : 1 - entryYes;
  const livePrice  = trade.side === "YES" ? liveYesPrice : 1 - liveYesPrice;
  if (entryPrice <= 0) return 0;
  return trade.amount_usdc * (livePrice / entryPrice - 1);
}

/**
 * Forecast EV — expected profit/loss if held to expiry, based on our probability estimate.
 *
 *   p(win)        = my_pct/100  (YES) or (100−my_pct)/100  (NO)
 *   profit_if_win = amount × (1/entry_price − 1)
 *   EV            = p(win) × profit_if_win − (1−p(win)) × amount
 *
 * Uses the ENTRY price (what was actually paid), not the live price.
 * Answers: "given what I paid, what do I expect to make if my forecast is right?"
 */
function calcForecastEv(trade: Trade): number {
  const entryYes   = getEntryYesPrice(trade);
  const entryPrice = trade.side === "YES" ? entryYes : 1 - entryYes;
  const pWin       = trade.side === "YES" ? trade.my_pct / 100 : (100 - trade.my_pct) / 100;
  const profit     = entryPrice > 0 ? trade.amount_usdc * (1 - entryPrice) / entryPrice : 0;
  return pWin * profit - (1 - pWin) * trade.amount_usdc;
}

/** Is this trade eligible for live-price polling? */
function isLivePriceEligible(trade: Trade, today: string): boolean {
  return trade.outcome === "pending" && trade.target_date >= today;
}

// ── Order status helpers ──────────────────────────────────────────────────────

function isActiveOrder(trade: Trade): boolean {
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

// ── Time formatting ───────────────────────────────────────────────────────────

function formatTimeAgo(date: Date): string {
  const secs = Math.floor((Date.now() - date.getTime()) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function HistoryClient({ initialTrades }: Props) {
  const [trades, setTrades]     = useState<Trade[]>(initialTrades);
  const [updating, setUpdating] = useState<string | null>(null);
  const [canceling, setCanceling] = useState<string | null>(null);
  const { toasts, addToast, dismiss } = useToasts();

  // Live price state
  const [livePrices, setLivePrices]       = useState<Map<string, number>>(new Map());
  const [lastPriceFetch, setLastPriceFetch] = useState<Date | null>(null);
  const [pricesFetching, setPricesFetching] = useState(false);
  const [, setTick] = useState(0); // force re-render for "updated Xm ago" clock

  // Stable refs so callbacks always see latest values
  const tradesRef     = useRef(trades);
  const livePricesRef = useRef(livePrices);
  useEffect(() => { tradesRef.current     = trades;     }, [trades]);
  useEffect(() => { livePricesRef.current = livePrices; }, [livePrices]);

  const today = new Date().toISOString().split("T")[0];

  // ── Live price polling ───────────────────────────────────────────────────

  const fetchLivePrices = useCallback(async () => {
    const candidates = tradesRef.current.filter((t) => isLivePriceEligible(t, today));
    if (candidates.length === 0) return;

    setPricesFetching(true);
    try {
      const results = await Promise.allSettled(
        candidates.map((t) =>
          fetch(`/api/live-price?ticker=${encodeURIComponent(t.market_id)}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((j: { ticker: string; yes_price: number } | null) =>
              j?.yes_price != null ? { ticker: t.market_id, yes_price: j.yes_price } : null
            )
        )
      );

      setLivePrices((prev) => {
        const next = new Map(prev);
        for (const r of results) {
          if (r.status === "fulfilled" && r.value) {
            next.set(r.value.ticker, r.value.yes_price);
          }
        }
        return next;
      });
      setLastPriceFetch(new Date());
    } finally {
      setPricesFetching(false);
    }
  }, [today]);

  // Fetch on mount, then every 5 minutes
  useEffect(() => {
    fetchLivePrices();
    const priceInterval = setInterval(fetchLivePrices, 5 * 60 * 1000);
    // Tick every 60 s to keep "updated Xm ago" fresh
    const clockInterval = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => {
      clearInterval(priceInterval);
      clearInterval(clockInterval);
    };
  }, [fetchLivePrices]);

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
        const old     = prev.find((t) => t.id === tradeId);
        const updated = prev.map((t) => t.id === tradeId ? { ...t, ...json } : t);

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
    } catch { /* ignore */ }
  }, [addToast]);

  useEffect(() => {
    function pollAll() {
      tradesRef.current.filter(isActiveOrder).forEach((t) => pollOrder(t.id));
    }
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
          prev.map((t) => t.id === tradeId ? { ...t, order_status: "canceled" as OrderStatus } : t)
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

  const total    = trades.length;
  const settled  = trades.filter((t) => t.outcome !== "pending");
  const pending  = trades.filter((t) => t.outcome === "pending");
  const wins     = trades.filter((t) => t.outcome === "win").length;
  const winRate  = settled.length > 0 ? Math.round((wins / settled.length) * 100) : null;
  const settledPnl = settled.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const avgEdge    = total > 0 ? Math.round(trades.reduce((s, t) => s + t.edge, 0) / total) : 0;

  // Projected P&L summary: mark-to-market for priced trades, 0 for unpriced
  // (MTM is the real current position value; unpriced contribute unknown MTM = excluded)
  const projectedPnl = pending.reduce((sum, t) => {
    const live = livePrices.get(t.market_id);
    return sum + (live != null ? calcMarkToMarket(t, live) : 0);
  }, 0);

  const liveCount = pending.filter((t) => livePrices.has(t.market_id)).length;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">

      {/* Toasts */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map((toast) => (
          <div key={toast.id} onClick={() => dismiss(toast.id)}
            className={`pointer-events-auto px-4 py-3 rounded-xl shadow-xl text-sm font-medium
              border backdrop-blur-sm cursor-pointer transition-all
              ${toast.type === "fill"   ? "bg-emerald-900/90 border-emerald-500/40 text-emerald-200" : ""}
              ${toast.type === "cancel" ? "bg-slate-800/90 border-slate-600/40 text-slate-300" : ""}
              ${toast.type === "error"  ? "bg-red-900/90 border-red-500/40 text-red-200" : ""}`}>
            {toast.message}
          </div>
        ))}
      </div>

      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold text-white">Trade History</h1>

        {/* Live price indicator */}
        {pending.length > 0 && (
          <div className="flex items-center gap-2 text-xs">
            {pricesFetching ? (
              <span className="flex items-center gap-1.5 text-sky-400">
                <span className="animate-pulse">●</span> Fetching prices…
              </span>
            ) : lastPriceFetch ? (
              <span className="flex items-center gap-1.5 text-slate-500">
                <span className="text-emerald-500">●</span>
                Live · updated {formatTimeAgo(lastPriceFetch)}
                {liveCount > 0 && ` · ${liveCount} price${liveCount !== 1 ? "s" : ""}`}
              </span>
            ) : null}
            <button
              onClick={fetchLivePrices}
              disabled={pricesFetching}
              className="px-2 py-1 rounded-md bg-slate-700 hover:bg-slate-600 text-slate-300 disabled:opacity-40 transition-colors">
              ↻
            </button>
          </div>
        )}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <SummaryCard label="Total Trades" value={String(total)}
          sub={pending.length > 0 ? `${pending.length} pending` : undefined}
        />
        <SummaryCard
          label="Win Rate"
          value={winRate !== null ? `${winRate}%` : "—"}
          sub={settled.length > 0 ? `${wins}/${settled.length} settled` : "No settled trades"}
        />
        <SummaryCard
          label="Settled P&L"
          value={settledPnl !== 0 ? `${settledPnl >= 0 ? "+" : ""}$${settledPnl.toFixed(2)}` : "$0.00"}
          valueClass={settledPnl > 0 ? "text-emerald-400" : settledPnl < 0 ? "text-red-400" : "text-white"}
          sub={settled.length > 0 ? `${settled.length} settled trade${settled.length !== 1 ? "s" : ""}` : undefined}
        />
        <SummaryCard
          label="Projected P&L"
          value={pending.length > 0
            ? `${projectedPnl >= 0 ? "+" : ""}$${projectedPnl.toFixed(2)}`
            : "—"}
          valueClass={pending.length === 0 ? "text-slate-500"
            : projectedPnl > 0 ? "text-emerald-400"
            : projectedPnl < 0 ? "text-red-400"
            : "text-white"}
          sub={pending.length > 0
            ? liveCount > 0 ? `live prices · ${liveCount} of ${pending.length}` : `${pending.length} pending · EV`
            : "No pending trades"}
          projected
        />
      </div>

      {/* Trades — empty state */}
      {trades.length === 0 ? (
        <div className="text-center py-20 text-slate-500">
          <p className="text-4xl mb-3">📊</p>
          <p className="text-lg font-medium">No trades logged yet</p>
          <p className="text-sm mt-1">Head to Markets to find edges and log your first trade.</p>
        </div>
      ) : (
        <>
          {/* ── Mobile card list (< md) ─────────────────────────────────── */}
          <div className="md:hidden space-y-3">
            {trades.map((trade) => (
              <TradeCard
                key={trade.id}
                trade={trade}
                liveYesPrice={livePrices.get(trade.market_id)}
                today={today}
                updating={updating === trade.id}
                canceling={canceling === trade.id}
                onUpdateOutcome={(outcome) =>
                  updateOutcome(trade.id, outcome, trade.amount_usdc, trade.market_pct)
                }
                onCancel={() => cancelOrder(trade.id)}
              />
            ))}
          </div>

          {/* ── Desktop table (≥ md) ────────────────────────────────────── */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 uppercase tracking-wider border-b border-slate-700">
                  <th className="pb-3 pr-4">Date</th>
                  <th className="pb-3 pr-4">Market</th>
                  <th className="pb-3 pr-4">Side</th>
                  <th className="pb-3 pr-4">Amount</th>
                  <th className="pb-3 pr-4">Signal</th>
                  <th className="pb-3 pr-4">Edge</th>
                  <th className="pb-3 pr-4">Order</th>
                  <th className="pb-3 pr-4">Live Price</th>
                  <th className="pb-3 pr-4">Outcome</th>
                  <th className="pb-3">P&L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {trades.map((trade) => (
                  <TradeRow
                    key={trade.id}
                    trade={trade}
                    liveYesPrice={livePrices.get(trade.market_id)}
                    today={today}
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
        </>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SummaryCard({
  label, value, sub, valueClass = "text-white", projected = false,
}: {
  label: string; value: string; sub?: string; valueClass?: string; projected?: boolean;
}) {
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
      <p className="text-xs text-slate-500 uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${valueClass}`}>
        {projected && value !== "—" && (
          <span className="text-base font-normal text-slate-500 mr-0.5">~</span>
        )}
        {value}
      </p>
      {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}

// ── Shared props type ─────────────────────────────────────────────────────────

interface TradeRowProps {
  trade: Trade;
  liveYesPrice: number | undefined;
  today: string;
  updating: boolean;
  canceling: boolean;
  onUpdateOutcome: (outcome: Trade["outcome"]) => void;
  onCancel: () => void;
}

// ── Mobile card ───────────────────────────────────────────────────────────────

function TradeCard({
  trade, liveYesPrice, today, updating, canceling, onUpdateOutcome, onCancel,
}: TradeRowProps) {
  const isPending   = trade.outcome === "pending";
  const hasFuture   = trade.target_date >= today;
  const eligible    = isPending && hasFuture;

  const entryYes    = getEntryYesPrice(trade);
  const entryPrice  = trade.side === "YES" ? entryYes : 1 - entryYes;
  const livePrice   = liveYesPrice != null
    ? (trade.side === "YES" ? liveYesPrice : 1 - liveYesPrice)
    : null;
  const priceDelta  = livePrice != null ? livePrice - entryPrice : null;
  const movedFavorably = priceDelta != null && priceDelta > 0.005;
  const movedAgainst   = priceDelta != null && priceDelta < -0.005;

  const mtm         = isPending && liveYesPrice != null ? calcMarkToMarket(trade, liveYesPrice) : null;
  const forecastEv  = isPending ? calcForecastEv(trade) : null;
  const pnlColor    = trade.pnl == null ? "" : trade.pnl >= 0 ? "text-emerald-400" : "text-red-400";

  const showCancel  = trade.kalshi_order_id &&
    (trade.order_status === "resting" || trade.order_status === "partially_filled" || trade.order_status === null);

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 space-y-3">
      {/* Row 1: date + market name */}
      <div className="flex items-start gap-3">
        <span className="shrink-0 text-xs text-slate-500 pt-0.5 whitespace-nowrap">
          {new Date(trade.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
        </span>
        <a
          href={trade.polymarket_url ?? "#"}
          target="_blank"
          rel="noopener noreferrer"
          className="text-slate-200 hover:text-sky-400 transition-colors text-sm leading-snug"
        >
          {trade.market_question}
        </a>
      </div>

      {/* Row 2: side + amount + order status + P&L */}
      <div className="flex items-start justify-between gap-3">
        {/* Left: side / amount / signal / order status */}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className={`font-semibold ${trade.side === "YES" ? "text-emerald-400" : "text-red-400"}`}>
            {trade.side}
          </span>
          <span className="text-slate-300">${trade.amount_usdc.toFixed(2)}</span>
          <SignalBadge signal={trade.signal} />
          {trade.order_status && <OrderStatusBadge status={trade.order_status} />}
          {showCancel && (
            <button
              onClick={onCancel}
              disabled={canceling}
              className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50 transition-colors min-h-[44px] px-1"
            >
              {canceling ? "Canceling…" : "Cancel"}
            </button>
          )}
        </div>

        {/* Right: P&L */}
        <div className="shrink-0 text-right">
          {trade.pnl != null ? (
            <span className={`font-semibold ${pnlColor}`}>
              {trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}
            </span>
          ) : mtm != null ? (
            <div className="flex flex-col items-end gap-0.5">
              <div className="flex items-baseline gap-1">
                <span className="text-xs text-slate-500">~</span>
                <span className={`font-semibold ${mtm >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {mtm >= 0 ? "+" : ""}${mtm.toFixed(2)}
                </span>
              </div>
              <span className="text-xs text-slate-600">if sold now</span>
            </div>
          ) : forecastEv != null ? (
            <div className="flex flex-col items-end gap-0.5">
              <div className="flex items-baseline gap-1">
                <span className="text-xs text-slate-500">~</span>
                <span className={`font-semibold ${forecastEv >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {forecastEv >= 0 ? "+" : ""}${forecastEv.toFixed(2)}
                </span>
              </div>
              <span className="text-xs text-slate-600">Forecast EV</span>
            </div>
          ) : (
            <span className="text-slate-600 text-sm">—</span>
          )}
        </div>
      </div>

      {/* Row 3: live price (if eligible) + outcome selector */}
      <div className="flex items-center justify-between gap-3 pt-1 border-t border-slate-700/50">
        {/* Live price */}
        <div className="text-xs">
          {eligible ? (
            livePrice != null ? (
              <span className={
                movedFavorably ? "text-emerald-400" :
                movedAgainst   ? "text-red-400" :
                "text-slate-400"
              }>
                {movedFavorably ? "↑ " : movedAgainst ? "↓ " : ""}
                {(livePrice * 100).toFixed(1)}¢
                <span className="text-slate-500 ml-1">
                  (entry {(entryPrice * 100).toFixed(1)}¢)
                </span>
              </span>
            ) : (
              <span className="text-slate-500 animate-pulse">fetching…</span>
            )
          ) : (
            <span className="text-slate-600">—</span>
          )}
        </div>

        {/* Outcome selector */}
        <select
          value={trade.outcome}
          disabled={updating}
          onChange={(e) => onUpdateOutcome(e.target.value as Trade["outcome"])}
          className="bg-slate-700 border border-slate-600 rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-sky-500 disabled:opacity-50 min-h-[44px]"
        >
          <option value="pending">Pending</option>
          <option value="win">Win</option>
          <option value="loss">Loss</option>
        </select>
      </div>
    </div>
  );
}

// ── Desktop table row ─────────────────────────────────────────────────────────

function TradeRow({ trade, liveYesPrice, today, updating, canceling, onUpdateOutcome, onCancel }: TradeRowProps) {
  const edgeColor =
    trade.edge >= 25 ? "text-emerald-400" :
    trade.edge >= 10 ? "text-sky-400" :
    trade.edge <= -10 ? "text-red-400" : "text-slate-400";

  const pnlColor = trade.pnl == null ? "" : trade.pnl >= 0 ? "text-emerald-400" : "text-red-400";

  const showCancel = trade.kalshi_order_id &&
    (trade.order_status === "resting" || trade.order_status === "partially_filled" || trade.order_status === null);

  const isPending = trade.outcome === "pending";
  const hasFuture = trade.target_date >= today;
  const eligible  = isPending && hasFuture;

  // Entry prices (relevant to position side)
  const entryYes  = getEntryYesPrice(trade);
  const entryPrice = trade.side === "YES" ? entryYes : 1 - entryYes; // price of the side bought

  // Live price (also in terms of the position side)
  const livePrice  = liveYesPrice != null
    ? (trade.side === "YES" ? liveYesPrice : 1 - liveYesPrice)
    : null;

  // Price delta: positive = moved in favor of the position
  const priceDelta = livePrice != null ? livePrice - entryPrice : null;
  const movedFavorably = priceDelta != null && priceDelta > 0.005;
  const movedAgainst   = priceDelta != null && priceDelta < -0.005;

  // P&L numbers for pending trades
  const mtm         = isPending && liveYesPrice != null ? calcMarkToMarket(trade, liveYesPrice) : null;
  const forecastEv  = isPending ? calcForecastEv(trade) : null;

  return (
    <tr className="hover:bg-slate-800/50 transition-colors">
      {/* Date */}
      <td className="py-3 pr-4 text-slate-400 whitespace-nowrap">
        {new Date(trade.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
      </td>

      {/* Market */}
      <td className="py-3 pr-4 max-w-[200px]">
        <a href={trade.polymarket_url ?? "#"} target="_blank" rel="noopener noreferrer"
          className="text-slate-200 hover:text-sky-400 transition-colors line-clamp-2 leading-snug">
          {trade.market_question}
        </a>
      </td>

      {/* Side */}
      <td className="py-3 pr-4">
        <span className={`font-semibold ${trade.side === "YES" ? "text-emerald-400" : "text-red-400"}`}>
          {trade.side}
        </span>
      </td>

      {/* Amount */}
      <td className="py-3 pr-4 text-slate-200 whitespace-nowrap">
        ${trade.amount_usdc.toFixed(2)}
      </td>

      {/* Signal */}
      <td className="py-3 pr-4"><SignalBadge signal={trade.signal} /></td>

      {/* Edge */}
      <td className={`py-3 pr-4 font-semibold ${edgeColor} whitespace-nowrap`}>
        {trade.edge > 0 ? "+" : ""}{trade.edge}
      </td>

      {/* Order status */}
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
                <button onClick={onCancel} disabled={canceling}
                  className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50 transition-colors">
                  {canceling ? "Canceling…" : "Cancel"}
                </button>
              )}
            </>
          ) : (
            <span className="text-xs text-slate-600">—</span>
          )}
        </div>
      </td>

      {/* Live Price */}
      <td className="py-3 pr-4 whitespace-nowrap">
        {eligible ? (
          <div className="flex flex-col gap-0.5">
            {livePrice != null ? (
              <>
                {/* Current price */}
                <span className={`font-semibold text-sm ${
                  movedFavorably ? "text-emerald-400" :
                  movedAgainst   ? "text-red-400" :
                  "text-white"
                }`}>
                  {movedFavorably ? "↑ " : movedAgainst ? "↓ " : ""}
                  {(livePrice * 100).toFixed(1)}¢
                </span>
                {/* Entry price + delta */}
                <span className="text-xs text-slate-500">
                  entry {(entryPrice * 100).toFixed(1)}¢
                  {priceDelta != null && Math.abs(priceDelta) > 0.005 && (
                    <span className={movedFavorably ? " text-emerald-500" : " text-red-500"}>
                      {" "}{priceDelta > 0 ? "+" : ""}{(priceDelta * 100).toFixed(1)}pp
                    </span>
                  )}
                </span>
              </>
            ) : (
              <span className="text-xs text-slate-500 animate-pulse">fetching…</span>
            )}
          </div>
        ) : (
          <span className="text-slate-600 text-xs">—</span>
        )}
      </td>

      {/* Outcome */}
      <td className="py-3 pr-4">
        <select value={trade.outcome} disabled={updating}
          onChange={(e) => onUpdateOutcome(e.target.value as Trade["outcome"])}
          className="bg-slate-700 border border-slate-600 rounded-lg px-2 py-1 text-sm text-white focus:outline-none focus:ring-2 focus:ring-sky-500 disabled:opacity-50">
          <option value="pending">Pending</option>
          <option value="win">Win</option>
          <option value="loss">Loss</option>
        </select>
      </td>

      {/* P&L */}
      <td className="py-3 whitespace-nowrap">
        {trade.pnl != null ? (
          // Settled — actual realised P&L
          <span className={`font-semibold ${pnlColor}`}>
            {trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}
          </span>
        ) : mtm != null ? (
          // Pending with live price — mark-to-market + forecast EV label
          <div className="flex flex-col gap-0.5">
            {/* MTM — the real number */}
            <div className="flex items-baseline gap-1">
              <span className="text-xs text-slate-500 font-normal">~</span>
              <span className={`font-semibold ${mtm >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {mtm >= 0 ? "+" : ""}${mtm.toFixed(2)}
              </span>
            </div>
            <span className="text-xs text-slate-600">if sold now</span>
            {/* Forecast EV — clearly labelled as speculative */}
            {forecastEv != null && (
              <span className={`text-xs mt-0.5 ${forecastEv >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                Forecast EV: {forecastEv >= 0 ? "+" : ""}${forecastEv.toFixed(2)}
              </span>
            )}
          </div>
        ) : forecastEv != null ? (
          // Pending, no live price yet — forecast EV only
          <div className="flex flex-col gap-0.5">
            <div className="flex items-baseline gap-1">
              <span className="text-xs text-slate-500 font-normal">~</span>
              <span className={`font-semibold ${forecastEv >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {forecastEv >= 0 ? "+" : ""}${forecastEv.toFixed(2)}
              </span>
            </div>
            <span className="text-xs text-slate-600">Forecast EV</span>
          </div>
        ) : (
          <span className="text-slate-600">—</span>
        )}
      </td>
    </tr>
  );
}
