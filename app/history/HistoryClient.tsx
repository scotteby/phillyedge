"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { Trade, OrderStatus } from "@/lib/types";
import SignalBadge from "@/components/SignalBadge";
import { deriveTradeSignal, signalTooltip } from "@/lib/signal";

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
 * For resting or cancelled orders with a partial fill, uses only the
 * capital actually deployed (filled_count × entry_price) as the basis.
 */
function calcMarkToMarket(trade: Trade, liveYesPrice: number): number {
  const entryYes   = getEntryYesPrice(trade);
  const entryPrice = trade.side === "YES" ? entryYes : 1 - entryYes;
  const livePrice  = trade.side === "YES" ? liveYesPrice : 1 - liveYesPrice;
  if (entryPrice <= 0) return 0;
  // Resting or cancelled with partial fill: only count what actually executed
  const isPartialOrder =
    (trade.order_status === "resting" || trade.order_status === "canceled") &&
    (trade.filled_count ?? 0) > 0;
  const amount = isPartialOrder ? trade.filled_count! * entryPrice : trade.amount_usdc;
  return amount * (livePrice / entryPrice - 1);
}

/**
 * Potential profit if the trade resolves in your favour.
 *   profit = contracts × (1 − entry_price_per_contract)
 *
 * For resting/unfilled orders this is the profit you'd earn if the order
 * fills completely AND the market resolves correctly.
 * Returns null for settled trades — they already have a realised P&L.
 */
function calcPotentialProfit(trade: Trade): number | null {
  if (trade.outcome !== "pending") return null;
  const entryYes   = getEntryYesPrice(trade);
  const entryPrice = trade.side === "YES" ? entryYes : 1 - entryYes;
  if (entryPrice <= 0 || entryPrice >= 1) return null;
  const storedFilled = trade.filled_count ?? 0;
  const contracts    = storedFilled > 0
    ? storedFilled
    : Math.floor(trade.amount_usdc / entryPrice);
  if (contracts <= 0) return null;
  return parseFloat((contracts * (1 - entryPrice)).toFixed(2));
}

/**
 * The amount of capital actually deployed in this trade.
 * For a resting/cancelled order with a partial fill, only the filled
 * contracts represent real capital — the rest was never spent.
 */
function deployedAmount(trade: Trade): number {
  const entryYes   = getEntryYesPrice(trade);
  const entryPrice = trade.side === "YES" ? entryYes : 1 - entryYes;
  const filled     = trade.filled_count ?? 0;
  const isPartial  =
    (trade.order_status === "canceled" || trade.order_status === "resting" ||
     trade.order_status === "partially_filled") &&
    filled > 0 && filled * entryPrice < trade.amount_usdc - 0.01;
  return isPartial ? filled * entryPrice : trade.amount_usdc;
}

/** True when a cancelled/boosted order filled 0 contracts — nothing was spent. */
function isVoidCancelled(trade: Trade): boolean {
  // Sold trades are always real — never hide them regardless of order_status
  if (trade.outcome === "sold") return false;
  return (
    (trade.order_status === "canceled" || trade.outcome === "boosted") &&
    (trade.filled_count ?? 0) === 0
  );
}

/** Can this order be boosted (cancel + re-place at a higher price)? */
function isBoostable(trade: Trade): boolean {
  return (
    trade.outcome === "pending" &&
    (trade.order_status === "resting" || trade.order_status === "partially_filled") &&
    trade.kalshi_order_id != null
  );
}

/**
 * True when the order holds no contracts yet — no position to mark to market.
 * Covers: resting with 0 fills, cancelled with 0 fills.
 */
function hasNoPosition(trade: Trade): boolean {
  const filled = trade.filled_count ?? 0;
  return filled === 0 && (trade.order_status === "resting" || trade.order_status === "canceled");
}


/** Is this trade eligible for live-price polling? */
function isLivePriceEligible(trade: Trade, today: string): boolean {
  return trade.outcome === "pending" && trade.target_date >= today;
}

/** Can the user manually sell this position right now? */
function isSellable(trade: Trade): boolean {
  // filled_count may be null if order-status polling hasn't run yet;
  // fall back to order_status as the signal that contracts exist
  const hasFills =
    (trade.filled_count ?? 0) > 0 ||
    trade.order_status === "filled" ||
    trade.order_status === "partially_filled";
  return trade.outcome === "pending" && hasFills && trade.kalshi_order_id != null;
}

// ── Order status helpers ──────────────────────────────────────────────────────

function isActiveOrder(trade: Trade): boolean {
  if (!trade.kalshi_order_id) return false;
  if (trade.outcome !== "pending") return false; // don't poll settled/sold/boosted trades
  const s = trade.order_status;
  // Also re-poll filled orders whose contract count was never stored (filled_count = 0 / null)
  // so that "if correct" payout reflects the actual fill rather than an estimate.
  if (s === "filled" && (trade.filled_count ?? 0) === 0) return true;
  return s === "resting" || s === "partially_filled" || s === null;
}

function OrderStatusBadge({ status, filledCount }: { status: OrderStatus; filledCount?: number | null }) {
  if (status === null) return null;

  const map: Record<NonNullable<OrderStatus>, { label: string; classes: string }> = {
    resting:          { label: "🟡 Resting",   classes: "bg-yellow-500/15 text-yellow-300 border-yellow-500/30" },
    partially_filled: { label: "🟠 Partial",   classes: "bg-orange-500/15 text-orange-300 border-orange-500/30" },
    filled:           { label: "🟢 Filled",    classes: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
    canceled:         { label: "🔴 Cancelled", classes: "bg-red-500/15 text-red-300 border-red-500/30" },
    expired:          { label: "⚫ Expired",   classes: "bg-slate-500/20 text-slate-400 border-slate-500/30" },
  };

  // A cancelled order that had fills should show as Partial, not Cancelled —
  // the contracts that filled are real and "Cancelled" implies nothing happened.
  const entry = (status === "canceled" && (filledCount ?? 0) > 0)
    ? { label: "🟠 Partial", classes: "bg-orange-500/15 text-orange-300 border-orange-500/30" }
    : map[status];

  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${entry.classes}`}>
      {entry.label}
    </span>
  );
}

// ── Action button ─────────────────────────────────────────────────────────────

const ACTION_STYLES = {
  cancel: "border-red-500/40    text-red-400    hover:bg-red-500/15    hover:border-red-400",
  sell:   "border-amber-500/40  text-amber-400  hover:bg-amber-500/15  hover:border-amber-400",
  boost:  "border-sky-500/40    text-sky-400    hover:bg-sky-500/15    hover:border-sky-400",
} as const;

function ActionButton({
  variant, onClick, disabled, loading, label, loadingLabel,
}: {
  variant:      keyof typeof ACTION_STYLES;
  onClick:      (e: React.MouseEvent) => void;
  disabled?:    boolean;
  loading?:     boolean;
  label:        string;
  loadingLabel: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={`cursor-pointer text-xs font-semibold px-2 py-0.5 rounded-full border
        transition-colors disabled:opacity-40 ${ACTION_STYLES[variant]}`}
    >
      {loading ? loadingLabel : label}
    </button>
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

// ── Trade grouping ────────────────────────────────────────────────────────────

const SERIES_NAMES: Record<string, string> = {
  KXHIGHPHIL:   "High Temperature Philadelphia",
  KXLOWTPHIL:   "Low Temperature Philadelphia",
  KXPRECIPPHIL: "Precipitation Philadelphia",
};

const MONTH_MAP: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04",
  MAY: "05", JUN: "06", JUL: "07", AUG: "08",
  SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

/**
 * Parse the observation date from a Kalshi event key.
 * "KXLOWTPHIL-26APR29"  →  "2026-04-29"  (YYMMMDD format)
 * Returns null if the pattern doesn't match.
 */
function parseDateFromEventKey(eventKey: string): string | null {
  const m = eventKey.match(/-(\d{2})([A-Z]{3})(\d{2})$/);
  if (!m) return null;
  const [, yy, mon, dd] = m;
  const month = MONTH_MAP[mon];
  if (!month) return null;
  return `20${yy}-${month}-${dd}`;
}

function getTomorrow(today: string): string {
  const [y, m, day] = today.split("-").map(Number);
  // Construct in local time (no "Z") so DST / UTC offset can't shift the date
  const d = new Date(y, m - 1, day + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getDateLabel(targetDate: string, today: string, tomorrow: string): string {
  if (targetDate === today)    return "Today";
  if (targetDate === tomorrow) return "Tomorrow";
  return new Date(targetDate + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Strip the series+date prefix from a market_question, leaving just the bracket range. */
function getBracketLabel(question: string): string {
  const sep = question.lastIndexOf(" — ");
  return sep >= 0 ? question.slice(sep + 3) : question;
}

/**
 * Numeric sort key for a bracket label so brackets sort low→high.
 * "<46°F" → 45.5  |  "47–49°F" → 47  |  ">51°F" → 51
 */
function bracketSortKey(question: string): number {
  const label = getBracketLabel(question);
  const m     = label.match(/(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  // "<X" / "≤X" sits just below X; everything else sorts at its lower bound
  return (label.startsWith("<") || label.startsWith("≤")) ? n - 0.5 : n;
}

interface TradeGroup {
  key:        string;   // "KXHIGHPHIL__2026-04-30"
  series:     string;
  seriesName: string;
  targetDate: string;
  dateLabel:  string;
  trades:     Trade[];
}

const SIGNAL_RANK: Record<string, number> = {
  "strong-buy": 0, "buy": 1, "neutral": 2, "avoid": 3,
};

function buildGroups(trades: Trade[], today: string): TradeGroup[] {
  const tomorrow = getTomorrow(today);
  const map = new Map<string, Trade[]>();

  for (const t of trades) {
    // Group by Kalshi event key: strip the bracket suffix (last "-XXX" segment)
    // e.g. "KXLOWTPHIL-26APR29-T51" → "KXLOWTPHIL-26APR29"
    const parts    = t.market_id.split("-");
    const eventKey = (parts.length > 1 ? parts.slice(0, -1).join("-") : t.market_id).toUpperCase();
    if (!map.has(eventKey)) map.set(eventKey, []);
    map.get(eventKey)!.push(t);
  }

  const groups: TradeGroup[] = [];
  for (const [key, gTrades] of map) {
    const series     = key.split("-")[0];
    const seriesName = SERIES_NAMES[series] ?? series;
    // Parse date from event key (YYMMMDD) — authoritative, immune to bad DB values
    const targetDate = parseDateFromEventKey(key) ?? gTrades[0].target_date;
    const dateLabel  = getDateLabel(targetDate, today, tomorrow);
    // Sort within group by bracket range (low → high temperature)
    const sorted = [...gTrades].sort(
      (a, b) => bracketSortKey(a.market_question) - bracketSortKey(b.market_question)
    );
    groups.push({ key, series, seriesName, targetDate, dateLabel, trades: sorted });
  }

  // Sort groups: today → tomorrow → future (asc) → past (desc)
  return groups.sort((a, b) => {
    const rank = (g: TradeGroup) =>
      g.targetDate === today    ? 0 :
      g.targetDate === tomorrow ? 1 :
      g.targetDate > today      ? 2 : 3;
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    return ra <= 2
      ? a.targetDate.localeCompare(b.targetDate)   // future: oldest first
      : b.targetDate.localeCompare(a.targetDate);  // past: newest first
  });
}

function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    try {
      const stored = localStorage.getItem("phillyedge_collapsed_groups");
      if (stored) setCollapsed(new Set(JSON.parse(stored) as string[]));
    } catch { /* ignore */ }
  }, []);

  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      try {
        localStorage.setItem("phillyedge_collapsed_groups", JSON.stringify([...next]));
      } catch { /* ignore */ }
      return next;
    });
  }, []);

  return { collapsed, toggle };
}

// ── Main component ────────────────────────────────────────────────────────────

export default function HistoryClient({ initialTrades }: Props) {
  const [trades, setTrades]       = useState<Trade[]>(initialTrades);
  const [canceling, setCanceling] = useState<string | null>(null);
  const [selling, setSelling]     = useState<string | null>(null);
  const [sellModalTrade, setSellModalTrade]   = useState<Trade | null>(null);
  const [boostModalTrade, setBoostModalTrade] = useState<Trade | null>(null);
  const [boosting, setBoosting]   = useState<string | null>(null);
  const [viewMode, setViewMode]   = useState<"active" | "resting" | "all">("active");
  const [balance, setBalance]     = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(true);
  const { toasts, addToast, dismiss } = useToasts();
  const { collapsed, toggle: toggleGroup } = useCollapsedGroups();

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

  // Use local calendar date — toISOString() returns UTC which can be a different
  // calendar date than the user's local date (e.g. UTC-4 early morning).
  const d0    = new Date();
  const today = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, "0")}-${String(d0.getDate()).padStart(2, "0")}`;

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

  // ── Kalshi balance ───────────────────────────────────────────────────────

  const fetchBalance = useCallback(async () => {
    setBalanceLoading(true);
    try {
      const res  = await fetch("/api/balance");
      const json = await res.json();
      if (res.ok && json.balance_dollars != null) {
        setBalance(json.balance_dollars);
      }
    } catch { /* ignore */ } finally {
      setBalanceLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBalance();
  }, [fetchBalance]);

  // ── Order status polling ─────────────────────────────────────────────────

  const pollOrder = useCallback(async (tradeId: string) => {
    try {
      const res  = await fetch(`/api/order-status?trade_id=${tradeId}`);
      if (!res.ok) return;
      const json = await res.json() as {
        order_status:    OrderStatus;
        filled_count:    number;
        remaining_count: number;
        last_checked_at: string;
        outcome:         Trade["outcome"];
        pnl:             number | null;
        resolved:        boolean;
        entry_yes_price?: number;
      };

      setTrades((prev) => {
        const old     = prev.find((t) => t.id === tradeId);
        const updated = prev.map((t) =>
          t.id === tradeId ? { ...t, ...json } : t
        );

        if (old) {
          if (old.order_status !== json.order_status) {
            if (json.order_status === "filled") {
              const t = updated.find((x) => x.id === tradeId);
              addToast(`✅ Order filled — ${t?.market_question ?? tradeId}`, "fill");
            } else if (json.order_status === "partially_filled") {
              const t = updated.find((x) => x.id === tradeId);
              addToast(`🟠 Partial fill — ${t?.market_question ?? tradeId} (${json.filled_count} filled)`, "fill");
            }
          }
          }
        return updated;
      });
    } catch { /* ignore */ }
  }, [addToast]);

  const pollAll = useCallback(() => {
    tradesRef.current.filter(isActiveOrder).forEach((t) => pollOrder(t.id));
  }, [pollOrder]);

  useEffect(() => {
    pollAll();
    const interval = setInterval(pollAll, 60_000);
    return () => clearInterval(interval);
  }, [pollAll]);

  // One-time on mount: refresh fill prices for already-filled pending trades.
  // isActiveOrder skips these (filled_count > 0) but their entry_yes_price may
  // be the original limit price rather than the actual average fill price.
  useEffect(() => {
    const filledPending = tradesRef.current.filter(
      (t) => t.outcome === "pending" &&
              t.order_status === "filled" &&
              t.kalshi_order_id != null
    );
    filledPending.forEach((t) => pollOrder(t.id));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally runs once on mount only

  // ── Sell position ─────────────────────────────────────────────────────────

  async function sellPosition(tradeId: string) {
    setSelling(tradeId);
    setSellModalTrade(null);
    try {
      const res  = await fetch("/api/sell-position", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ trade_id: tradeId }),
      });
      const json = await res.json();
      if (res.ok) {
        setTrades((prev) =>
          prev.map((t) =>
            t.id === tradeId
              ? { ...t, outcome: "sold" as Trade["outcome"], pnl: json.pnl ?? null }
              : t
          )
        );
        const pnl = json.pnl as number | null;
        addToast(
          `💰 Sold — ${pnl != null ? `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}` : "P&L pending"}`,
          "fill"
        );
      } else {
        addToast(`Sell failed: ${json.error ?? "unknown error"}`, "error");
      }
    } catch (err) {
      addToast(`Sell error: ${String(err)}`, "error");
    } finally {
      setSelling(null);
    }
  }

  // ── Boost order ──────────────────────────────────────────────────────────

  async function boostOrder(tradeId: string, newPriceCents: number) {
    setBoosting(tradeId);
    setBoostModalTrade(null);
    try {
      const res  = await fetch("/api/boost-order", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ trade_id: tradeId, new_price_cents: newPriceCents }),
      });
      const json = await res.json();
      if (res.ok) {
        // Mark old trade as boosted; inject new trade at top of list
        setTrades((prev) => {
          const updated = prev.map((t) =>
            t.id === tradeId
              ? { ...t, outcome: "boosted" as Trade["outcome"], order_status: "canceled" as Trade["order_status"] }
              : t
          );
          // Append a placeholder for the new trade — will be refreshed on next poll
          if (json.new_trade_id) {
            updated.unshift({
              id:              json.new_trade_id,
              created_at:      new Date().toISOString(),
              market_id:       json.ticker,
              market_question: prev.find((t) => t.id === tradeId)?.market_question ?? "",
              target_date:     prev.find((t) => t.id === tradeId)?.target_date ?? "",
              side:            json.side,
              amount_usdc:     json.new_amount,
              market_pct:      json.new_price_cents,
              my_pct:          prev.find((t) => t.id === tradeId)?.my_pct ?? 50,
              edge:            json.new_edge,
              signal:          prev.find((t) => t.id === tradeId)?.signal ?? "buy",
              outcome:         "pending",
              pnl:             null,
              polymarket_url:  prev.find((t) => t.id === tradeId)?.polymarket_url ?? null,
              kalshi_order_id: json.new_order_id ?? null,
              order_status:    "resting",
              filled_count:    0,
              remaining_count: json.count ?? null,
              last_checked_at: null,
              entry_yes_price: json.side === "YES"
                ? json.new_price_cents / 100
                : 1 - json.new_price_cents / 100,
            });
          }
          return updated;
        });
        addToast(`↑ Boosted to ${newPriceCents}¢ — new order placed`, "fill");
      } else {
        addToast(`Boost failed: ${json.error ?? "unknown error"}`, "error");
      }
    } catch (err) {
      addToast(`Boost error: ${String(err)}`, "error");
    } finally {
      setBoosting(null);
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

  // ── Filtered trade sets ───────────────────────────────────────────────────

  // Void-cancelled trades (order placed but 0 contracts filled) are excluded
  // from stats — they never deployed capital, so they didn't happen.
  const effectiveTrades = trades.filter((t) => !isVoidCancelled(t));

  // What's shown in the list depends on the view mode
  const restingTrades  = trades.filter((t) => t.order_status === "resting");
  const visibleTrades  =
    viewMode === "all"     ? trades :
    viewMode === "resting" ? restingTrades :
    effectiveTrades;

  // ── Summary stats (always off effectiveTrades) ────────────────────────────

  const total    = effectiveTrades.length;
  const settled  = effectiveTrades.filter((t) => t.outcome !== "pending");
  const pending  = effectiveTrades.filter((t) => t.outcome === "pending");
  const wins     = effectiveTrades.filter((t) => t.outcome === "win").length;
  const winRate  = settled.length > 0 ? Math.round((wins / settled.length) * 100) : null;
  const settledPnl = settled.reduce((s, t) => s + (t.pnl ?? 0), 0);

  const projectedPnl = pending.reduce((sum, t) => {
    if (hasNoPosition(t)) return sum;
    const live = livePrices.get(t.market_id);
    return sum + (live != null ? calcMarkToMarket(t, live) : 0);
  }, 0);

  const combinedPotential = pending.reduce((sum, t) => {
    const p = calcPotentialProfit(t);
    return p != null ? sum + p : sum;
  }, 0);

  const liveCount = pending.filter((t) => livePrices.has(t.market_id)).length;

  // ── Grouped view ─────────────────────────────────────────────────────────────
  const groups = buildGroups(visibleTrades, today);
  const activeMarketCount = groups.filter(
    (g) => g.targetDate >= today && g.trades.some((t) => t.outcome === "pending")
  ).length;

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
        <div className="flex items-center gap-4 flex-wrap">
          <h1 className="text-2xl font-bold text-white">Trades</h1>
          <button
            onClick={fetchBalance}
            disabled={balanceLoading}
            title="Refresh balance"
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 hover:border-slate-500 transition-colors disabled:opacity-50"
          >
            <span className="text-xs text-slate-500 uppercase tracking-wide">Balance</span>
            {balanceLoading ? (
              <span className="text-sm text-slate-500 animate-pulse">…</span>
            ) : balance != null ? (
              <span className="text-sm font-semibold text-emerald-400">${balance.toFixed(2)}</span>
            ) : (
              <span className="text-sm text-slate-600">—</span>
            )}
          </button>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* View toggle */}
          <div className="flex rounded-lg overflow-hidden border border-slate-700 text-xs">
            <button
              onClick={() => setViewMode("active")}
              className={`px-3 py-1.5 transition-colors ${viewMode === "active" ? "bg-slate-700 text-white font-medium" : "text-slate-400 hover:text-slate-200"}`}
            >
              Active &amp; Settled
            </button>
            <button
              onClick={() => setViewMode("resting")}
              className={`px-3 py-1.5 transition-colors border-l border-slate-700 ${viewMode === "resting" ? "bg-slate-700 text-white font-medium" : "text-slate-400 hover:text-slate-200"}`}
            >
              Orders
              {restingTrades.length > 0 && (
                <span className="ml-1 text-yellow-400">({restingTrades.length})</span>
              )}
            </button>
            <button
              onClick={() => setViewMode("all")}
              className={`px-3 py-1.5 transition-colors border-l border-slate-700 ${viewMode === "all" ? "bg-slate-700 text-white font-medium" : "text-slate-400 hover:text-slate-200"}`}
            >
              All trades
            </button>
          </div>

          {/* Live price + order status refresh */}
          {pending.length > 0 && (
            <div className="flex items-center gap-2 text-xs">
              {pricesFetching ? (
                <span className="flex items-center gap-1.5 text-sky-400">
                  <span className="animate-pulse">●</span> Refreshing…
                </span>
              ) : lastPriceFetch ? (
                <span className="flex items-center gap-1.5 text-slate-500">
                  <span className="text-emerald-500">●</span>
                  Live · updated {formatTimeAgo(lastPriceFetch)}
                  {liveCount > 0 && ` · ${liveCount} price${liveCount !== 1 ? "s" : ""}`}
                </span>
              ) : null}
              <button
                onClick={() => { pollAll(); fetchLivePrices(); }}
                disabled={pricesFetching}
                title="Refresh order statuses and live prices"
                className="px-2 py-1 rounded-md bg-slate-700 hover:bg-slate-600 text-slate-300 disabled:opacity-40 transition-colors">
                ↻
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <SummaryCard
          label="Active Markets"
          value={String(activeMarketCount)}
          sub={pending.length > 0 ? `${pending.length} open trade${pending.length !== 1 ? "s" : ""}` : "No pending trades"}
        />
        <SummaryCard
          label="Total Trades"
          value={String(total)}
          sub={settled.length > 0 ? `${wins}/${settled.length} settled won` : "No settled trades"}
        />
        <SummaryCard
          label="Net Projected P&L"
          value={pending.length > 0
            ? `${projectedPnl >= 0 ? "+" : ""}$${projectedPnl.toFixed(2)}`
            : settledPnl !== 0 ? `${settledPnl >= 0 ? "+" : ""}$${settledPnl.toFixed(2)}` : "—"}
          valueClass={
            (pending.length > 0 ? projectedPnl : settledPnl) > 0 ? "text-emerald-400" :
            (pending.length > 0 ? projectedPnl : settledPnl) < 0 ? "text-red-400" : "text-white"}
          sub={pending.length > 0
            ? liveCount > 0 ? `live · ${liveCount} of ${pending.length} priced` : "mark-to-market"
            : settled.length > 0 ? `${settled.length} settled` : undefined}
          projected={pending.length > 0}
        />
        <SummaryCard
          label="Combined If Correct"
          value={combinedPotential > 0 ? `+$${combinedPotential.toFixed(2)}` : "—"}
          valueClass={combinedPotential > 0 ? "text-sky-400" : "text-slate-500"}
          sub={pending.length > 0 ? "if all pending win" : undefined}
        />
      </div>

      {/* Trades — empty state or grouped list */}
      {visibleTrades.length === 0 ? (
        <div className="text-center py-20 text-slate-500">
          <p className="text-4xl mb-3">📊</p>
          <p className="text-lg font-medium">
            {trades.length === 0 ? "No trades logged yet"
              : viewMode === "resting" ? "No open orders"
              : "No active or settled trades"}
          </p>
          <p className="text-sm mt-1">
            {trades.length === 0
              ? "Head to Markets to find edges and log your first trade."
              : viewMode === "resting"
              ? <button onClick={() => setViewMode("active")} className="text-sky-400 hover:text-sky-300 underline">Show active &amp; settled trades</button>
              : <button onClick={() => setViewMode("all")} className="text-sky-400 hover:text-sky-300 underline">Show all trades</button>}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => {
            const isCollapsed = collapsed.has(group.key);
            const sharedProps = {
              livePrices, today, canceling, selling, boosting,
              onCancel: (id: string) => cancelOrder(id),
              onSell:   (t: Trade)   => setSellModalTrade(t),
              onBoost:  (t: Trade)   => setBoostModalTrade(t),
            };
            return (
              <div key={group.key}>
                {/* Group header */}
                <GroupHeader
                  group={group}
                  collapsed={isCollapsed}
                  onToggle={() => toggleGroup(group.key)}
                  livePrices={livePrices}
                  today={today}
                />

                {/* Trades within group */}
                {!isCollapsed && (
                  <>
                    {/* ── Mobile ──────────────────────────────────────── */}
                    <div className="md:hidden mt-2 pl-2 space-y-2">
                      {group.trades.map((trade) => (
                        <TradeCard
                          key={trade.id}
                          trade={trade}
                          liveYesPrice={livePrices.get(trade.market_id)}
                          today={today}
                          canceling={canceling === trade.id}
                          onCancel={() => cancelOrder(trade.id)}
                          selling={selling === trade.id}
                          onSell={() => setSellModalTrade(trade)}
                          boosting={boosting === trade.id}
                          onBoost={() => setBoostModalTrade(trade)}
                          groupMode
                        />
                      ))}
                    </div>

                    {/* ── Desktop ──────────────────────────────────────── */}
                    <div className="hidden md:block mt-1 overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-xs text-slate-500 uppercase tracking-wider border-b border-slate-700/50">
                            <th className="py-2 pr-4 pl-4">Bracket</th>
                            <th className="py-2 pr-4">Side</th>
                            <th className="py-2 pr-4">Amount</th>
                            <th className="py-2 pr-4">Signal</th>
                            <th className="py-2 pr-4">Edge</th>
                            <th className="py-2 pr-4">Order</th>
                            <th className="py-2 pr-4">Outcome</th>
                            <th className="py-2">P&L</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-700/30">
                          {group.trades.map((trade) => (
                            <TradeRow
                              key={trade.id}
                              trade={trade}
                              liveYesPrice={livePrices.get(trade.market_id)}
                              today={today}
                              canceling={canceling === trade.id}
                              onCancel={() => cancelOrder(trade.id)}
                              selling={selling === trade.id}
                              onSell={() => setSellModalTrade(trade)}
                              boosting={boosting === trade.id}
                              onBoost={() => setBoostModalTrade(trade)}
                              groupMode
                            />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      {/* Boost modal */}
      {boostModalTrade && (
        <BoostModal
          trade={boostModalTrade}
          boosting={boosting === boostModalTrade.id}
          onConfirm={(cents) => boostOrder(boostModalTrade.id, cents)}
          onClose={() => setBoostModalTrade(null)}
        />
      )}

      {/* Sell confirmation modal */}
      {sellModalTrade && (
        <SellModal
          trade={sellModalTrade}
          liveYesPrice={livePrices.get(sellModalTrade.market_id)}
          selling={selling === sellModalTrade.id}
          onConfirm={() => sellPosition(sellModalTrade.id)}
          onClose={() => setSellModalTrade(null)}
        />
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

// ── Sell confirmation modal ───────────────────────────────────────────────────

function SellModal({
  trade, liveYesPrice, selling, onConfirm, onClose,
}: {
  trade: Trade;
  liveYesPrice: number | undefined;
  selling: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const entryYes   = getEntryYesPrice(trade);
  const entryPrice = trade.side === "YES" ? entryYes : 1 - entryYes;
  const livePrice  = liveYesPrice != null
    ? (trade.side === "YES" ? liveYesPrice : 1 - liveYesPrice)
    : null;

  // filled_count may be null OR 0 if order-status polling hasn't stored the
  // real value yet (Kalshi fills set it, but polling may lag).
  // Estimate from amount_usdc / entry_price whenever the stored value is falsy.
  const storedFilled = trade.filled_count ?? 0;
  const contracts = storedFilled > 0
    ? storedFilled
    : (entryPrice > 0 ? Math.floor(trade.amount_usdc / entryPrice) : 0);
  const costBasis  = contracts * entryPrice;
  const estProceeds = livePrice != null ? contracts * livePrice : null;
  const estPnl      = estProceeds != null ? estProceeds - costBasis : null;
  const pnlColor    = estPnl == null ? "text-slate-400"
    : estPnl > 0  ? "text-emerald-400"
    : estPnl < 0  ? "text-red-400"
    : "text-slate-300";

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md bg-slate-800 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-5 pt-5 pb-4 border-b border-slate-700">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-white font-bold text-lg">Sell Position</h2>
              <p className="text-slate-400 text-sm mt-0.5 leading-snug">{trade.market_question}</p>
            </div>
            <button onClick={onClose} className="text-slate-500 hover:text-slate-300 text-xl leading-none mt-0.5">×</button>
          </div>
        </div>

        {/* Details grid */}
        <div className="px-5 py-4 grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">Side</p>
            <p className={`font-semibold ${trade.side === "YES" ? "text-emerald-400" : "text-red-400"}`}>
              {trade.side}
            </p>
          </div>
          <div>
            <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">Contracts</p>
            <p className="text-white font-semibold">{contracts}</p>
          </div>
          <div>
            <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">Entry Price</p>
            <p className="text-slate-200 font-medium">{(entryPrice * 100).toFixed(1)}¢</p>
          </div>
          <div>
            <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">Live Price</p>
            {livePrice != null
              ? <p className="text-slate-200 font-medium">{(livePrice * 100).toFixed(1)}¢</p>
              : <p className="text-slate-500">—</p>}
          </div>
          <div>
            <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">Cost Basis</p>
            <p className="text-slate-200 font-medium">${costBasis.toFixed(2)}</p>
          </div>
          <div>
            <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">Est. Proceeds</p>
            {estProceeds != null
              ? <p className="text-slate-200 font-medium">${estProceeds.toFixed(2)}</p>
              : <p className="text-slate-500">—</p>}
          </div>
        </div>

        {/* Est. P&L */}
        {estPnl != null && (
          <div className="px-5 pb-3">
            <div className="flex items-center justify-between bg-slate-900/50 rounded-lg px-4 py-2.5">
              <span className="text-slate-400 text-sm">Estimated P&amp;L</span>
              <span className={`font-bold text-base ${pnlColor}`}>
                {estPnl >= 0 ? "+" : ""}${estPnl.toFixed(2)}
              </span>
            </div>
          </div>
        )}

        {/* Disclaimer */}
        <div className="px-5 pb-4">
          <p className="text-xs text-slate-500 leading-relaxed">
            ⚠️ This places a <strong className="text-slate-400">market order</strong> on Kalshi.
            Final fill price may differ slightly from the live estimate above.
          </p>
        </div>

        {/* Buttons */}
        <div className="px-5 pb-5 flex gap-3">
          <button
            onClick={onClose}
            disabled={selling}
            className="flex-1 py-2.5 rounded-xl border border-slate-600 text-slate-300 hover:border-slate-500 hover:text-white transition-colors disabled:opacity-40 text-sm font-medium"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={selling}
            className="flex-1 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-white font-bold transition-colors text-sm"
          >
            {selling ? "Selling…" : `Sell ${contracts} contract${contracts !== 1 ? "s" : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Boost modal ───────────────────────────────────────────────────────────────

function BoostModal({
  trade, boosting, onConfirm, onClose,
}: {
  trade: Trade;
  boosting: boolean;
  onConfirm: (newPriceCents: number) => void;
  onClose: () => void;
}) {
  const [askCents, setAskCents]       = useState<number | null>(null);
  const [bidCents, setBidCents]       = useState<number | null>(null);
  const [loadingAsk, setLoadingAsk]   = useState(true);
  const [selected, setSelected]       = useState<"ask" | "+1" | "+2" | "custom">("ask");
  const [customInput, setCustomInput] = useState("");

  const entryYes   = getEntryYesPrice(trade);
  const entryPrice = trade.side === "YES" ? entryYes : 1 - entryYes;
  const currentCents = Math.round(entryPrice * 100);

  // Fetch current ask on mount
  useEffect(() => {
    setLoadingAsk(true);
    fetch(`/api/orderbook?ticker=${encodeURIComponent(trade.market_id)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((j) => {
        if (j) {
          const ask = trade.side === "YES" ? j.yes_ask_cents : j.no_ask_cents;
          const bid = trade.side === "YES" ? j.yes_bid_cents : j.no_bid_cents;
          setAskCents(ask ?? null);
          setBidCents(bid ?? null);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingAsk(false));
  }, [trade.market_id, trade.side]);

  // Derive the chosen price in cents
  const chosenCents: number | null = (() => {
    if (selected === "ask")    return askCents ?? currentCents + 3;
    if (selected === "+1")     return currentCents + 1;
    if (selected === "+2")     return currentCents + 2;
    if (selected === "custom") {
      const n = parseInt(customInput, 10);
      return !isNaN(n) && n >= 1 && n <= 99 ? n : null;
    }
    return null;
  })();

  // DB stores 0 (not null) before polling updates remaining_count — must use > 0
  const storedRemaining = trade.remaining_count;
  const contracts = (storedRemaining != null && storedRemaining > 0)
    ? storedRemaining
    : (entryPrice > 0 ? Math.floor(trade.amount_usdc / entryPrice) : 0);

  const newCost     = chosenCents != null ? (chosenCents / 100) * contracts : null;
  const oldCost     = entryPrice * contracts;
  const costDiff    = newCost != null ? newCost - oldCost : null;

  // Edge at chosen price: my_pct - new_price_cents
  const newEdge     = chosenCents != null ? trade.my_pct - chosenCents : null;
  const edgeNegative = newEdge != null && newEdge < 0;

  const options: { key: "ask" | "+1" | "+2" | "custom"; label: string; cents: number | null }[] = [
    { key: "ask",    label: askCents != null ? `Match ask: ${askCents}¢ — fills now` : (loadingAsk ? "Match ask: loading…" : "Match ask"), cents: askCents },
    { key: "+1",     label: `+1¢ → ${currentCents + 1}¢`,  cents: currentCents + 1 },
    { key: "+2",     label: `+2¢ → ${currentCents + 2}¢`,  cents: currentCents + 2 },
    { key: "custom", label: "Custom price",                 cents: null },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md bg-slate-800 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-5 pt-5 pb-4 border-b border-slate-700">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-white font-bold text-lg">Improve Order Price</h2>
              <p className="text-slate-400 text-sm mt-0.5 leading-snug">{trade.market_question}</p>
            </div>
            <button onClick={onClose} className="text-slate-500 hover:text-slate-300 text-xl leading-none mt-0.5">×</button>
          </div>
        </div>

        {/* Current order info */}
        <div className="px-5 py-4 flex gap-6 text-sm border-b border-slate-700/50">
          <div>
            <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">Current limit</p>
            <p className="text-white font-semibold">{currentCents}¢ {trade.side}</p>
          </div>
          <div>
            <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">Current ask</p>
            {loadingAsk ? (
              <p className="text-slate-500 animate-pulse">…</p>
            ) : askCents != null ? (
              <p className="text-sky-300 font-semibold">{askCents}¢</p>
            ) : (
              <p className="text-slate-500">—</p>
            )}
          </div>
          <div>
            <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">Contracts</p>
            <p className="text-white font-semibold">{contracts}</p>
          </div>
          <div>
            <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">Orig edge</p>
            <p className={`font-semibold ${trade.edge >= 10 ? "text-emerald-400" : trade.edge >= 0 ? "text-sky-400" : "text-red-400"}`}>
              {trade.edge > 0 ? "+" : ""}{trade.edge}pt
            </p>
          </div>
        </div>

        {/* Price options */}
        <div className="px-5 py-4 space-y-2">
          {options.map((opt) => (
            <button
              key={opt.key}
              onClick={() => setSelected(opt.key)}
              className={`w-full text-left px-4 py-2.5 rounded-xl border transition-colors text-sm ${
                selected === opt.key
                  ? "border-sky-500 bg-sky-500/10 text-sky-300"
                  : "border-slate-600 text-slate-300 hover:border-slate-500 hover:text-white"
              }`}
            >
              {opt.label}
            </button>
          ))}
          {selected === "custom" && (
            <div className="flex items-center gap-2 mt-2">
              <input
                type="number"
                min={currentCents + 1}
                max={99}
                value={customInput}
                onChange={(e) => setCustomInput(e.target.value)}
                placeholder={`> ${currentCents}¢`}
                className="flex-1 bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-sky-500"
                autoFocus
              />
              <span className="text-slate-400 text-sm">¢</span>
            </div>
          )}
        </div>

        {/* Cost + edge summary */}
        {chosenCents != null && (
          <div className="px-5 pb-4 space-y-2">
            <div className="bg-slate-900/50 rounded-lg px-4 py-3 space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-400">Cost at {chosenCents}¢</span>
                <span className="text-white font-medium">${newCost?.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Original cost</span>
                <span className="text-slate-300">${oldCost.toFixed(2)}</span>
              </div>
              {costDiff != null && costDiff !== 0 && (
                <div className="flex justify-between border-t border-slate-700/50 pt-1.5">
                  <span className="text-slate-400">Difference</span>
                  <span className={costDiff > 0 ? "text-amber-400" : "text-emerald-400"}>
                    {costDiff > 0 ? "+" : ""}${costDiff.toFixed(2)} more
                  </span>
                </div>
              )}
            </div>
            {newEdge != null && (
              <div className={`flex items-center gap-2 text-sm px-3 py-2 rounded-lg border ${
                edgeNegative
                  ? "bg-red-500/10 border-red-500/30 text-red-400"
                  : "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
              }`}>
                {edgeNegative ? (
                  <span>⚠️ Edge goes negative at {chosenCents}¢ — you'd be overpaying vs your forecast</span>
                ) : (
                  <span>✓ Still {newEdge > 0 ? "+" : ""}{newEdge}pt edge at {chosenCents}¢</span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Buttons */}
        <div className="px-5 pb-5 flex gap-3">
          <button
            onClick={onClose}
            disabled={boosting}
            className="flex-1 py-2.5 rounded-xl border border-slate-600 text-slate-300 hover:border-slate-500 hover:text-white transition-colors disabled:opacity-40 text-sm font-medium"
          >
            Cancel
          </button>
          <button
            onClick={() => chosenCents != null && onConfirm(chosenCents)}
            disabled={boosting || chosenCents == null || chosenCents <= currentCents}
            className="flex-1 py-2.5 rounded-xl bg-sky-500 hover:bg-sky-400 disabled:opacity-40 text-white font-bold transition-colors text-sm"
          >
            {boosting ? "Boosting…" : chosenCents != null ? `Boost to ${chosenCents}¢ ↑` : "Select a price"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Group header ──────────────────────────────────────────────────────────────

function GroupHeader({
  group, collapsed, onToggle, livePrices,
}: {
  group:      TradeGroup;
  collapsed:  boolean;
  onToggle:   () => void;
  livePrices: Map<string, number>;
  today:      string;
}) {
  const pendingTrades = group.trades.filter((t) => t.outcome === "pending");
  const settledTrades = group.trades.filter((t) => t.outcome !== "pending");

  const settledPnl   = settledTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const projectedPnl = pendingTrades.reduce((sum, t) => {
    if (hasNoPosition(t)) return sum;
    const live = livePrices.get(t.market_id);
    return sum + (live != null ? calcMarkToMarket(t, live) : 0);
  }, 0);
  const netPnl = settledPnl + projectedPnl;

  const combinedPotential = pendingTrades.reduce((sum, t) => {
    const p = calcPotentialProfit(t);
    return p != null ? sum + p : sum;
  }, 0);

  const hasMtm  = pendingTrades.some((t) => livePrices.has(t.market_id));
  const hasPnl  = settledTrades.length > 0 || hasMtm;
  const showNet = hasPnl || settledTrades.length > 0;

  const pendingCount  = pendingTrades.length;
  const settledCount  = settledTrades.length;
  const countLabel    = pendingCount > 0 && settledCount > 0
    ? `${pendingCount} pending · ${settledCount} settled`
    : pendingCount > 0
    ? `${pendingCount} pending`
    : `${settledCount} settled`;

  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-between gap-4 px-4 py-3 bg-slate-800/60 border border-slate-700 rounded-xl hover:border-slate-600 transition-colors text-left"
    >
      {/* Left: name + meta */}
      <div className="flex items-center gap-3 min-w-0">
        <span className={`text-slate-400 text-base leading-none transition-transform duration-150 shrink-0 ${collapsed ? "" : "rotate-90"}`}>›</span>
        <div className="min-w-0">
          <p className="text-white font-semibold text-sm">{group.seriesName}</p>
          <p className="text-slate-400 text-xs mt-0.5">
            {group.dateLabel} · {countLabel}
          </p>
        </div>
      </div>

      {/* Right: P&L / potential */}
      <div className="flex items-center gap-5 shrink-0">
        {showNet && (
          <div className="text-right">
            <p className="text-slate-500 uppercase tracking-wide text-[10px]">
              {hasMtm ? "~Net P&L" : "Net P&L"}
            </p>
            <p className={`text-sm font-semibold ${netPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
              {netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)}
            </p>
          </div>
        )}
        {combinedPotential > 0 && (
          <div className="text-right">
            <p className="text-slate-500 uppercase tracking-wide text-[10px]">If correct</p>
            <p className="text-sm font-semibold text-sky-400">+${combinedPotential.toFixed(2)}</p>
          </div>
        )}
      </div>
    </button>
  );
}

// ── Shared props type ─────────────────────────────────────────────────────────

interface TradeRowProps {
  trade: Trade;
  liveYesPrice: number | undefined;
  today: string;
  canceling: boolean;
  onCancel: () => void;
  selling: boolean;
  onSell: () => void;
  boosting: boolean;
  onBoost: () => void;
  /** When true: hide date column; show bracket label instead of full question */
  groupMode?: boolean;
}

// ── Outcome badge ─────────────────────────────────────────────────────────────

function OutcomeBadge({ outcome }: { outcome: Trade["outcome"] }) {
  const map: Record<NonNullable<Trade["outcome"]>, { label: string; classes: string }> = {
    pending: { label: "🟡 Pending", classes: "bg-yellow-500/15 text-yellow-300 border-yellow-500/30" },
    win:     { label: "🟢 Win",     classes: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
    loss:    { label: "🔴 Loss",    classes: "bg-red-500/15 text-red-300 border-red-500/30" },
    sold:    { label: "⚪ Sold",    classes: "bg-slate-500/20 text-slate-400 border-slate-500/30" },
    boosted: { label: "↑ Boosted",  classes: "bg-sky-500/15 text-sky-400 border-sky-500/30" },
  };
  const { label, classes } = map[outcome ?? "pending"];
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${classes}`}>
      {label}
    </span>
  );
}

// ── Mobile card ───────────────────────────────────────────────────────────────

function TradeCard({
  trade, liveYesPrice, today, canceling, onCancel, selling, onSell, boosting, onBoost,
  groupMode = false,
}: TradeRowProps) {
  const [expanded, setExpanded] = useState(false);

  const isPending  = trade.outcome === "pending";
  const entryYes   = getEntryYesPrice(trade);
  const entryPrice = trade.side === "YES" ? entryYes : 1 - entryYes;
  const livePrice  = liveYesPrice != null
    ? (trade.side === "YES" ? liveYesPrice : 1 - liveYesPrice)
    : null;
  const priceDelta     = livePrice != null ? livePrice - entryPrice : null;
  const movedFavorably = priceDelta != null && priceDelta > 0.005;
  const movedAgainst   = priceDelta != null && priceDelta < -0.005;

  const noPosition      = hasNoPosition(trade);
  const mtm             = isPending && !noPosition && liveYesPrice != null ? calcMarkToMarket(trade, liveYesPrice) : null;
  const potentialProfit = calcPotentialProfit(trade);
  const pnlColor        = trade.pnl == null ? "" : trade.pnl >= 0 ? "text-emerald-400" : "text-red-400";

  const showCancel = trade.kalshi_order_id &&
    (trade.order_status === "resting" || trade.order_status === "partially_filled" || trade.order_status === null);
  const showSell  = isSellable(trade);
  const showBoost = isBoostable(trade);

  const contractCount = trade.filled_count ?? (entryPrice > 0 ? Math.floor(trade.amount_usdc / entryPrice) : null);

  return (
    <div
      className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden cursor-pointer select-none"
      onClick={() => setExpanded((v) => !v)}
    >
      <div className="p-4 space-y-3">
        {/* Row 1: date + market name + chevron */}
        <div className="flex items-start gap-2">
          {!groupMode && (
            <span className="shrink-0 text-xs text-slate-500 pt-0.5 whitespace-nowrap">
              {new Date(trade.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            </span>
          )}
          <a
            href={trade.polymarket_url ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 text-slate-200 hover:text-sky-400 transition-colors text-sm leading-snug"
            onClick={(e) => e.stopPropagation()}
          >
            {groupMode ? getBracketLabel(trade.market_question) : trade.market_question}
          </a>
          <span className={`shrink-0 text-slate-500 text-base leading-none transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}>
            ›
          </span>
        </div>

        {/* Row 2: badges | P&L */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm min-w-0">
            <span className={`font-semibold ${trade.side === "YES" ? "text-emerald-400" : "text-red-400"}`}>
              {trade.side}
            </span>
            <span className="text-slate-300">${deployedAmount(trade).toFixed(2)}</span>
            {(() => {
              const sig = deriveTradeSignal(trade.side, trade.edge);
              return <SignalBadge signal={sig} title={signalTooltip(sig, trade.side, trade.edge)} />;
            })()}
            {trade.order_status && <OrderStatusBadge status={trade.order_status} filledCount={trade.filled_count} />}
            {showCancel && (
              <ActionButton variant="cancel" onClick={(e) => { e.stopPropagation(); onCancel(); }}
                loading={canceling} label="Cancel" loadingLabel="Canceling…" />
            )}
            {showSell && (
              <ActionButton variant="sell" onClick={(e) => { e.stopPropagation(); onSell(); }}
                loading={selling} label="Sell" loadingLabel="Selling…" />
            )}
            {showBoost && (
              <ActionButton variant="boost" onClick={(e) => { e.stopPropagation(); onBoost(); }}
                loading={boosting} label="Boost ↑" loadingLabel="Boosting…" />
            )}
          </div>
          <div className="shrink-0 text-right">
            {trade.pnl != null ? (
              <span className={`font-medium ${pnlColor}`}>
                {trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}
              </span>
            ) : noPosition ? (
              <span className="text-slate-400 font-medium">$0.00</span>
            ) : mtm != null ? (
              <span className={`font-medium ${mtm >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                ~{mtm >= 0 ? "+" : ""}${mtm.toFixed(2)}
              </span>
            ) : (
              <span className="text-slate-600 text-sm">—</span>
            )}
            {potentialProfit != null && (
              <p className="text-[10px] text-slate-500 mt-0.5">
                🎯 +${potentialProfit.toFixed(2)} if correct
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Outcome badge */}
      <div className="px-4 pb-3">
        <OutcomeBadge outcome={trade.outcome} />
      </div>

      {/* Expandable detail panel */}
      {expanded && (
        <div className="border-t border-slate-700/50 px-4 py-3 bg-slate-900/40 space-y-3">
          <div className="grid grid-cols-3 gap-3 text-xs">
            <div>
              <p className="text-slate-500 uppercase tracking-wide text-[10px] mb-1">Entry</p>
              <p className="text-slate-200 font-medium">{(entryPrice * 100).toFixed(1)}¢</p>
            </div>
            <div>
              <p className="text-slate-500 uppercase tracking-wide text-[10px] mb-1">Live</p>
              {livePrice != null ? (
                <p className={`font-medium ${movedFavorably ? "text-emerald-400" : movedAgainst ? "text-red-400" : "text-slate-200"}`}>
                  {(livePrice * 100).toFixed(1)}¢
                </p>
              ) : (
                <p className="text-slate-600">—</p>
              )}
            </div>
            <div>
              <p className="text-slate-500 uppercase tracking-wide text-[10px] mb-1">Move</p>
              {priceDelta != null && Math.abs(priceDelta) > 0.001 ? (
                <p className={`font-medium ${movedFavorably ? "text-emerald-400" : movedAgainst ? "text-red-400" : "text-slate-400"}`}>
                  {priceDelta > 0 ? "+" : ""}{(priceDelta * 100).toFixed(1)}pp
                </p>
              ) : (
                <p className="text-slate-600">—</p>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <p className="text-slate-500 uppercase tracking-wide text-[10px] mb-1">Contracts</p>
              <p className="text-slate-200 font-medium">
                {trade.filled_count != null
                  ? `${trade.filled_count} filled${trade.remaining_count ? ` / ${trade.remaining_count} left` : ""}`
                  : contractCount != null ? `~${contractCount}` : "—"}
              </p>
            </div>
            <div>
              <p className="text-slate-500 uppercase tracking-wide text-[10px] mb-1">Ticker</p>
              <p className="text-slate-400 font-mono text-[11px] break-all">{trade.market_id}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Desktop table row ─────────────────────────────────────────────────────────

function TradeRow({ trade, liveYesPrice, today, canceling, onCancel, selling, onSell, boosting, onBoost, groupMode = false }: TradeRowProps) {
  const [expanded, setExpanded] = useState(false);

  const edgeColor =
    trade.edge >= 25 ? "text-emerald-400" :
    trade.edge >= 10 ? "text-sky-400" :
    trade.edge <= -10 ? "text-red-400" : "text-slate-400";

  const pnlColor   = trade.pnl == null ? "" : trade.pnl >= 0 ? "text-emerald-400" : "text-red-400";
  const showCancel = trade.kalshi_order_id &&
    (trade.order_status === "resting" || trade.order_status === "partially_filled" || trade.order_status === null);
  const showSell  = isSellable(trade);
  const showBoost = isBoostable(trade);

  const isPending  = trade.outcome === "pending";
  const entryYes   = getEntryYesPrice(trade);
  const entryPrice = trade.side === "YES" ? entryYes : 1 - entryYes;
  const livePrice  = liveYesPrice != null
    ? (trade.side === "YES" ? liveYesPrice : 1 - liveYesPrice)
    : null;
  const priceDelta     = livePrice != null ? livePrice - entryPrice : null;
  const movedFavorably = priceDelta != null && priceDelta > 0.005;
  const movedAgainst   = priceDelta != null && priceDelta < -0.005;
  const noPosition      = hasNoPosition(trade);
  const mtm             = isPending && !noPosition && liveYesPrice != null ? calcMarkToMarket(trade, liveYesPrice) : null;
  const potentialProfit = calcPotentialProfit(trade);
  const contractCount   = trade.filled_count ?? (entryPrice > 0 ? Math.floor(trade.amount_usdc / entryPrice) : null);

  return (
    <>
      <tr
        className="hover:bg-slate-800/50 transition-colors cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
      >
        {/* Date — hidden in groupMode */}
        {!groupMode && (
          <td className="py-3 pr-4 text-slate-400 whitespace-nowrap pl-4">
            {new Date(trade.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </td>
        )}

        {/* Market / Bracket */}
        <td className={`py-3 pr-4 max-w-[220px] ${groupMode ? "pl-4" : ""}`}>
          <a href={trade.polymarket_url ?? "#"} target="_blank" rel="noopener noreferrer"
            className="text-slate-200 hover:text-sky-400 transition-colors line-clamp-2 leading-snug"
            onClick={(e) => e.stopPropagation()}>
            {groupMode ? getBracketLabel(trade.market_question) : trade.market_question}
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
          ${deployedAmount(trade).toFixed(2)}
        </td>

        {/* Signal — derived from side + edge so NO trades show the correct signal */}
        <td className="py-3 pr-4">
          {(() => {
            const sig = deriveTradeSignal(trade.side, trade.edge);
            return <SignalBadge signal={sig} title={signalTooltip(sig, trade.side, trade.edge)} />;
          })()}
        </td>

        {/* Edge */}
        <td className={`py-3 pr-4 font-semibold ${edgeColor} whitespace-nowrap`}>
          {trade.edge > 0 ? "+" : ""}{trade.edge}
        </td>

        {/* Order status */}
        <td className="py-3 pr-4" onClick={(e) => e.stopPropagation()}>
          <div className="flex flex-col gap-1.5 items-start">
            {trade.kalshi_order_id ? (
              <>
                <OrderStatusBadge status={trade.order_status} filledCount={trade.filled_count} />
                {trade.order_status === "partially_filled" && trade.filled_count != null && (
                  <span className="text-xs text-slate-500">
                    {trade.filled_count} filled / {trade.remaining_count} left
                  </span>
                )}
                {showCancel && (
                  <ActionButton variant="cancel" onClick={(e) => { e.stopPropagation(); onCancel(); }}
                    loading={canceling} label="Cancel" loadingLabel="Canceling…" />
                )}
                {showSell && (
                  <ActionButton variant="sell" onClick={(e) => { e.stopPropagation(); onSell(); }}
                    loading={selling} label="Sell" loadingLabel="Selling…" />
                )}
                {showBoost && (
                  <ActionButton variant="boost" onClick={(e) => { e.stopPropagation(); onBoost(); }}
                    loading={boosting} label="Boost ↑" loadingLabel="Boosting…" />
                )}
              </>
            ) : (
              <span className="text-xs text-slate-600">—</span>
            )}
          </div>
        </td>

        {/* Outcome */}
        <td className="py-3 pr-4" onClick={(e) => e.stopPropagation()}>
          <OutcomeBadge outcome={trade.outcome} />
        </td>

        {/* P&L + expand chevron */}
        <td className="py-3 whitespace-nowrap">
          <div className="flex items-center gap-2">
            <div className="flex flex-col">
              {trade.pnl != null ? (
                <span className={`font-semibold ${pnlColor}`}>
                  {trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}
                </span>
              ) : noPosition ? (
                <span className="text-slate-400 font-semibold">$0.00</span>
              ) : mtm != null ? (
                <span className={`font-semibold ${mtm >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  ~{mtm >= 0 ? "+" : ""}${mtm.toFixed(2)}
                </span>
              ) : (
                <span className="text-slate-600">—</span>
              )}
              {potentialProfit != null && (
                <span className="text-xs text-slate-500 mt-0.5">
                  🎯 +${potentialProfit.toFixed(2)} if correct
                </span>
              )}
            </div>
            <span className={`text-slate-600 text-base leading-none transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}>
              ›
            </span>
          </div>
        </td>
      </tr>

      {/* Expandable detail row */}
      {expanded && (
        <tr>
          <td colSpan={groupMode ? 8 : 9} className="pb-3 pt-0">
            <div className="mx-0 bg-slate-900/40 border border-slate-700/40 rounded-lg px-4 py-3 flex gap-8 text-xs">
              <div>
                <p className="text-slate-500 uppercase tracking-wide text-[10px] mb-1">Entry</p>
                <p className="text-slate-200 font-medium">{(entryPrice * 100).toFixed(1)}¢</p>
              </div>
              <div>
                <p className="text-slate-500 uppercase tracking-wide text-[10px] mb-1">Live</p>
                {livePrice != null ? (
                  <p className={`font-medium ${movedFavorably ? "text-emerald-400" : movedAgainst ? "text-red-400" : "text-slate-200"}`}>
                    {(livePrice * 100).toFixed(1)}¢
                  </p>
                ) : (
                  <p className="text-slate-600">—</p>
                )}
              </div>
              <div>
                <p className="text-slate-500 uppercase tracking-wide text-[10px] mb-1">Move</p>
                {priceDelta != null && Math.abs(priceDelta) > 0.001 ? (
                  <p className={`font-medium ${movedFavorably ? "text-emerald-400" : movedAgainst ? "text-red-400" : "text-slate-400"}`}>
                    {priceDelta > 0 ? "+" : ""}{(priceDelta * 100).toFixed(1)}pp
                  </p>
                ) : (
                  <p className="text-slate-600">—</p>
                )}
              </div>
              <div>
                <p className="text-slate-500 uppercase tracking-wide text-[10px] mb-1">Contracts</p>
                <p className="text-slate-200 font-medium">
                  {trade.filled_count != null
                    ? `${trade.filled_count} filled${trade.remaining_count ? ` / ${trade.remaining_count} left` : ""}`
                    : contractCount != null ? `~${contractCount}` : "—"}
                </p>
              </div>
              <div>
                <p className="text-slate-500 uppercase tracking-wide text-[10px] mb-1">Ticker</p>
                <p className="text-slate-400 font-mono">{trade.market_id}</p>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
