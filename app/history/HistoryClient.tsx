"use client";

import { Fragment, useState, useEffect, useCallback, useRef } from "react";
import type { Trade, OrderStatus } from "@/lib/types";
import SignalBadge from "@/components/SignalBadge";
import { deriveTradeSignal, signalTooltip } from "@/lib/signal";
import { buildPositions, type Position, type PositionState, getEntryYesPrice as modelGetEntryYesPrice, getContractsForFill, getBracketLabel as modelGetBracketLabel } from "@/lib/position-model";

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
  // Fully-cancelled orders (0 fills) have no open position — nothing left to profit from.
  // Partially-cancelled (some fills) still have live contracts, so keep showing "if correct".
  if (trade.order_status === "canceled" && (trade.filled_count ?? 0) === 0) return null;
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
  // "Partial" badge shows for canceled/boosted orders that had partial fills —
  // those are real contracts we can still sell.
  // "boosted" is intentionally NOT excluded: a boosted order that partially
  // filled before being replaced still holds contracts that need to be sold.
  const notSettled =
    trade.outcome !== "win" &&
    trade.outcome !== "loss" &&
    trade.outcome !== "sold";
  const hasFills =
    (trade.filled_count ?? 0) > 0 ||
    trade.order_status === "filled" ||
    trade.order_status === "partially_filled";
  return notSettled && hasFills;
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
  cancel:    "border-red-500/40    text-red-400    hover:bg-red-500/15    hover:border-red-400",
  sell:      "border-amber-500/40  text-amber-400  hover:bg-amber-500/15  hover:border-amber-400",
  boost:     "border-sky-500/40    text-sky-400    hover:bg-sky-500/15    hover:border-sky-400",
  reconcile: "border-slate-500/40  text-slate-400  hover:bg-slate-500/15  hover:border-slate-400",
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

  // Sort groups: descending by close date (furthest future first → most recent past last)
  return groups.sort((a, b) => b.targetDate.localeCompare(a.targetDate));
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
  const [sellModalTrades, setSellModalTrades] = useState<Trade[] | null>(null);
  const [boostModalTrade, setBoostModalTrade] = useState<Trade | null>(null);
  const [boosting, setBoosting]   = useState<string | null>(null);
  const [syncing, setSyncing]     = useState(false);
  const [viewMode, setViewMode]   = useState<"active" | "history">("active");
  const [historyDays, setHistoryDays] = useState<7 | 30 | 90 | null>(30);
  const [showCancelled, setShowCancelled] = useState(false);
  const [balance, setBalance]     = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(true);
  const { toasts, addToast, dismiss } = useToasts();
  const { collapsed, toggle: toggleGroup } = useCollapsedGroups();
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

  function toggleExpand(key: string) {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

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

  async function sellPosition(tradeId: string, sellPriceCents?: number) {
    setSelling(tradeId);
    setSellModalTrades(null);
    try {
      const res  = await fetch("/api/sell-position", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ trade_id: tradeId, sell_price_cents: sellPriceCents }),
      });
      const json = await res.json();
      if (res.ok) {
        if (json.filled === false) {
          // Limit sell didn't match immediately — order is resting on Kalshi.
          // kalshi_order_id has been swapped to the sell order; keep the trade
          // as pending so it shows in Pending Orders with Boost / Cancel buttons.
          setTrades((prev) =>
            prev.map((t) =>
              t.id === tradeId
                ? {
                    ...t,
                    order_status:   "resting" as Trade["order_status"],
                    filled_count:   t.filled_count ?? json.contracts_sold ?? null,
                    remaining_count: -1, // sentinel: marks this as a resting sell order
                  }
                : t
            )
          );
          addToast("⏳ Sell order resting — use Boost or Cancel in Pending Orders", "fill");
        } else {
          // Filled immediately — mark sold in local state
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
        }
      } else {
        addToast(`Sell failed: ${json.error ?? "unknown error"}`, "error");
      }
    } catch (err) {
      addToast(`Sell error: ${String(err)}`, "error");
    } finally {
      setSelling(null);
    }
  }

  /** Always open the sell confirmation modal — for both single and multi-fill positions. */
  function handlePositionSell(fills: Trade[]) {
    if (fills.length > 0) setSellModalTrades(fills);
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

  // ── Sync open orders from Kalshi ─────────────────────────────────────────
  // Fetches all resting/partially_filled orders from Kalshi and inserts DB
  // records for any that are missing (e.g. when a boost's DB insert failed).

  async function syncOrders() {
    setSyncing(true);
    try {
      const res  = await fetch("/api/sync-orders", { method: "POST" });
      const json = await res.json();
      if (res.ok && json.recovered?.length > 0) {
        // Inject recovered trades into local state so they appear immediately
        const newTrades: Trade[] = json.recovered.map((r: Record<string, unknown>) => ({
          id:              String(r.trade_id),
          created_at:      new Date().toISOString(),
          market_id:       String(r.ticker),
          market_question: String(r.ticker),
          target_date:     null,
          side:            String(r.side) as Trade["side"],
          amount_usdc:     0,
          market_pct:      Number(r.market_pct) || 50,
          my_pct:          50,
          edge:            0,
          signal:          "buy" as Trade["signal"],
          outcome:         "pending" as Trade["outcome"],
          pnl:             null,
          polymarket_url:  null,
          kalshi_order_id: String(r.order_id),
          order_status:    String(r.order_status) as Trade["order_status"],
          filled_count:    Number(r.filled)    || 0,
          remaining_count: Number(r.remaining) || 0,
          last_checked_at: null,
          entry_yes_price: null,
        }));
        setTrades((prev) => [...newTrades, ...prev]);
        addToast(`✅ Recovered ${json.recovered.length} missing order${json.recovered.length !== 1 ? "s" : ""} from Kalshi`, "fill");
      } else if (res.ok) {
        addToast(`✓ All Kalshi orders already tracked (${json.found} open)`, "fill");
      } else {
        addToast(`Sync failed: ${json.error ?? "unknown error"}`, "error");
      }
    } catch (err) {
      addToast(`Sync error: ${String(err)}`, "error");
    } finally {
      setSyncing(false);
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
        const restoredStatus = (json.order_status ?? "canceled") as OrderStatus;
        setTrades((prev) =>
          prev.map((t) => t.id === tradeId ? { ...t, order_status: restoredStatus } : t)
        );
        addToast(json.is_sell_order ? "Sell order cancelled — position restored." : "Order cancelled.", "cancel");
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

  /** Convert an ISO timestamp (UTC) to local-timezone YYYY-MM-DD. */
  function dateInLocalTZ(iso: string): string {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // Void-cancelled = boosted predecessors or cancelled orders with 0 fills.
  // Hidden by default in both views (no capital deployed, no real position).
  const nonVoidTrades = trades.filter((t) => !isVoidCancelled(t));

  // ── Active & Settled view ─────────────────────────────────────────────────
  // Scope: all open positions (any age) + trades for today's or yesterday's
  // markets.  "Yesterday" is included so that a market that resolved May 1
  // (win, loss, OR previously sold fills) remains visible on May 2 without
  // relying on last_checked_at being refreshed — sold trades don't have
  // last_checked_at updated when settlement runs, so the old check was fragile.
  const yesterday = (() => {
    const d = new Date(today + "T12:00:00");
    d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();

  const activeVisibleTrades = nonVoidTrades.filter((t) => {
    if (t.outcome === "pending") return true;                   // all open positions
    if (dateInLocalTZ(t.created_at) === today) return true;    // placed today
    // Show settled/sold/closed trades whose market resolved today or yesterday
    if (t.outcome === "win" || t.outcome === "loss" || t.outcome === "sold") {
      return t.target_date != null && t.target_date >= yesterday;
    }
    return false;
  });

  // ── History view ──────────────────────────────────────────────────────────
  // Scope: all trades within the selected date range.
  // showCancelled=false (default) hides void-cancelled; true surfaces them.
  const historyStartDate: string | null = historyDays != null ? (() => {
    const d = new Date();
    d.setDate(d.getDate() - historyDays);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })() : null;

  const historyBase = showCancelled ? trades : nonVoidTrades;
  const historyVisibleTrades = historyBase.filter((t) =>
    historyStartDate === null || dateInLocalTZ(t.created_at) >= historyStartDate
  );

  // ── Active view for the current mode ─────────────────────────────────────
  const visibleTrades = viewMode === "history" ? historyVisibleTrades : activeVisibleTrades;

  // ── Summary stats — scoped to visible trades ──────────────────────────────
  // Exclude resting-only orders from counts (no capital deployed yet).
  const summaryTrades = visibleTrades.filter((t) => t.order_status !== "resting" || (t.filled_count ?? 0) > 0);

  const total      = summaryTrades.length;
  const settled    = summaryTrades.filter((t) => t.outcome !== "pending");
  const pending    = summaryTrades.filter((t) => t.outcome === "pending");
  const wins       = summaryTrades.filter((t) => t.outcome === "win").length;
  const settledPnl = settled.reduce((s, t) => s + (t.pnl ?? 0), 0);

  const liveCount = pending.filter((t) => livePrices.has(t.market_id)).length;

  // Position-based P&L math
  const summaryPositions = buildPositions(summaryTrades);

  // Realized P&L from settled/sold positions
  const totalRealizedPnl = summaryPositions.reduce((s, p) => s + p.realizedPnl, 0);

  // Unrealized P&L from open positions using live prices
  const totalUnrealizedPnl = summaryPositions.reduce((sum, p) => {
    if (p.netContracts <= 0) return sum;
    const liveYes = livePrices.get(p.market_id);
    if (liveYes == null) return sum;
    const livePrice = p.side === "YES" ? liveYes : 1 - liveYes;
    return sum + p.netContracts * (livePrice - p.avgBuyPrice);
  }, 0);

  const projectedPnl = totalRealizedPnl + totalUnrealizedPnl;

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
              onClick={() => setViewMode("history")}
              className={`px-3 py-1.5 transition-colors border-l border-slate-700 ${viewMode === "history" ? "bg-slate-700 text-white font-medium" : "text-slate-400 hover:text-slate-200"}`}
            >
              History
            </button>
          </div>

          {/* Sync missing orders from Kalshi */}
          <button
            onClick={syncOrders}
            disabled={syncing}
            title="Recover any Kalshi orders missing from the DB"
            className="px-2.5 py-1.5 rounded-lg text-xs bg-slate-800 border border-slate-700 hover:border-sky-500/50 hover:text-sky-400 text-slate-400 disabled:opacity-40 transition-colors"
          >
            {syncing ? "Syncing…" : "⟳ Sync Kalshi"}
          </button>

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
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {viewMode === "active" ? (
          <>
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
          </>
        ) : (
          <>
            <SummaryCard
              label="Trades in Range"
              value={String(total)}
              sub={settled.length > 0 ? `${settled.length} settled` : "No settled trades"}
            />
            <SummaryCard
              label="Win Rate"
              value={settled.length > 0 ? `${Math.round((wins / settled.length) * 100)}%` : "—"}
              sub={settled.length > 0 ? `${wins}/${settled.length} won` : "No settled trades"}
            />
            <SummaryCard
              label="Net P&L"
              value={settledPnl !== 0 ? `${settledPnl >= 0 ? "+" : ""}$${settledPnl.toFixed(2)}` : "—"}
              valueClass={settledPnl > 0 ? "text-emerald-400" : settledPnl < 0 ? "text-red-400" : "text-white"}
              sub={settled.length > 0 ? "realized" : undefined}
            />
          </>
        )}
      </div>

      {/* History filters */}
      {viewMode === "history" && (
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs text-slate-500 uppercase tracking-wider font-semibold">Range</span>
          <div className="flex gap-1">
            {([7, 30, 90, null] as const).map((d) => (
              <button
                key={String(d)}
                onClick={() => setHistoryDays(d)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors
                  ${historyDays === d
                    ? "bg-sky-600 text-white"
                    : "bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-700"}`}
              >
                {d == null ? "All time" : `${d}d`}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer select-none ml-2">
            <input
              type="checkbox"
              checked={showCancelled}
              onChange={(e) => setShowCancelled(e.target.checked)}
              className="rounded border-slate-600 bg-slate-800 text-sky-500 focus:ring-sky-500 focus:ring-offset-slate-900"
            />
            Show cancelled / voided
          </label>
        </div>
      )}

      {/* Trades — empty state or grouped list */}
      {visibleTrades.length === 0 ? (
        <div className="text-center py-20 text-slate-500">
          <p className="text-4xl mb-3">📊</p>
          <p className="text-lg font-medium">
            {trades.length === 0 ? "No trades logged yet" :
             viewMode === "history" ? "No trades in this date range" :
             "No active or settled trades"}
          </p>
          <p className="text-sm mt-1">
            {trades.length === 0
              ? "Head to Markets to find edges and log your first trade."
              : viewMode === "active"
              ? <button onClick={() => setViewMode("history")} className="text-sky-400 hover:text-sky-300 underline">View history</button>
              : null}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => {
            const isCollapsed = collapsed.has(group.key);
            const sharedProps = {
              livePrices, today, canceling, selling, boosting,
              onCancel: (id: string) => cancelOrder(id),
              onSell:   (t: Trade)   => setSellModalTrades([t]),
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
                  positions={buildPositions(group.trades)}
                />

                {/* Trades within group */}
                {!isCollapsed && (() => {
                  const positions = buildPositions(group.trades);
                  const allPending = positions.flatMap((p) => p.pendingOrders);

                  // Group positions by bracket label so YES+NO for the same
                  // bracket collapse into a single expandable row.
                  const bracketGroups: { bracket: string; positions: Position[] }[] = [];
                  const bracketIdx = new Map<string, number>();
                  for (const pos of positions.filter((p) => p.fills.length > 0)) {
                    if (bracketIdx.has(pos.bracket)) {
                      bracketGroups[bracketIdx.get(pos.bracket)!].positions.push(pos);
                    } else {
                      bracketIdx.set(pos.bracket, bracketGroups.length);
                      bracketGroups.push({ bracket: pos.bracket, positions: [pos] });
                    }
                  }

                  return (
                    <>
                      {/* ── Mobile ──────────────────────────────────────── */}
                      <div className="md:hidden mt-2 pl-2 space-y-2">
                        {bracketGroups.flatMap(({ positions: bPos }) =>
                          bPos.map((pos) => {
                            const isSingle   = pos.fills.length === 1;
                            const isExpanded = isSingle || expandedKeys.has(pos.key);
                            return (
                              <div key={pos.key}>
                                <PositionCard
                                  pos={pos}
                                  expanded={isExpanded}
                                  onToggle={() => toggleExpand(pos.key)}
                                  hasChildren={!isSingle}
                                  livePrices={livePrices}
                                  canceling={canceling}
                                  selling={selling}
                                  boosting={boosting}
                                  onCancel={cancelOrder}
                                  onSell={(fills) => handlePositionSell(fills)}
                                  onBoost={(t) => setBoostModalTrade(t)}
                                />
                                {!isSingle && isExpanded && pos.fills.map((t) => (
                                  <FillSubCard
                                    key={t.id}
                                    trade={t}
                                    liveYesPrice={livePrices.get(t.market_id)}
                                    canceling={canceling === t.id}
                                    selling={selling === t.id}
                                    boosting={boosting === t.id}
                                    onCancel={() => cancelOrder(t.id)}
                                    onSell={() => setSellModalTrades([t])}
                                    onBoost={() => setBoostModalTrade(t)}
                                  />
                                ))}
                              </div>
                            );
                          })
                        )}
                        {allPending.length > 0 && (
                          <div className="mt-2">
                            <p className="text-xs text-slate-500 uppercase tracking-wider font-semibold px-1 pb-1">Pending Orders</p>
                            {allPending.map((t) => (
                              <PendingOrderCard
                                key={t.id}
                                trade={t}
                                canceling={canceling === t.id}
                                boosting={boosting === t.id}
                                onCancel={() => cancelOrder(t.id)}
                                onBoost={() => setBoostModalTrade(t)}
                              />
                            ))}
                          </div>
                        )}
                      </div>

                      {/* ── Desktop ──────────────────────────────────────── */}
                      <div className="hidden md:block mt-1 overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-left text-xs text-slate-500 uppercase tracking-wider border-b border-slate-700/50">
                              <th className="py-2 pr-4 pl-4">Bracket</th>
                              <th className="py-2 pr-4">Side</th>
                              <th className="py-2 pr-4">State</th>
                              <th className="py-2 pr-4">Position</th>
                              <th className="py-2 pr-4">P&amp;L</th>
                              <th className="py-2">{/* Actions */}</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-700/30">
                            {bracketGroups.flatMap(({ positions: bPos }) =>
                              bPos.map((pos) => {
                                const isSingle   = pos.fills.length === 1;
                                const isExpanded = isSingle || expandedKeys.has(pos.key);
                                return (
                                  <Fragment key={pos.key}>
                                    <PositionRow
                                      pos={pos}
                                      expanded={isExpanded}
                                      onToggle={() => toggleExpand(pos.key)}
                                      hasChildren={!isSingle}
                                      livePrices={livePrices}
                                      canceling={canceling}
                                      selling={selling}
                                      boosting={boosting}
                                      onCancel={cancelOrder}
                                      onSell={(fills) => handlePositionSell(fills)}
                                      onBoost={(t) => setBoostModalTrade(t)}
                                    />
                                    {!isSingle && isExpanded && pos.fills.map((t) => (
                                      <FillSubRow
                                        key={t.id}
                                        trade={t}
                                        liveYesPrice={livePrices.get(t.market_id)}
                                        canceling={canceling === t.id}
                                        selling={selling === t.id}
                                        boosting={boosting === t.id}
                                        onCancel={() => cancelOrder(t.id)}
                                        onSell={() => setSellModalTrades([t])}
                                        onBoost={() => setBoostModalTrade(t)}
                                      />
                                    ))}
                                  </Fragment>
                                );
                              })
                            )}
                            {allPending.length > 0 && (
                              <>
                                <tr>
                                  <td colSpan={6} className="pt-4 pb-1 pl-4">
                                    <span className="text-xs text-slate-500 uppercase tracking-wider font-semibold">Pending Orders</span>
                                  </td>
                                </tr>
                                {allPending.map((t) => (
                                  <PendingOrderRow
                                    key={t.id}
                                    trade={t}
                                    canceling={canceling === t.id}
                                    boosting={boosting === t.id}
                                    onCancel={() => cancelOrder(t.id)}
                                    onBoost={() => setBoostModalTrade(t)}
                                  />
                                ))}
                              </>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </>
                  );
                })()}
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
      {sellModalTrades && sellModalTrades.length > 0 && (
        <SellModal
          trades={sellModalTrades}
          selling={sellModalTrades.some((t) => selling === t.id)}
          onConfirm={(priceCents) => {
            void (async () => {
              for (const t of sellModalTrades) {
                await sellPosition(t.id, priceCents);
              }
            })();
          }}
          onClose={() => setSellModalTrades(null)}
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
// Accepts 1+ fills for the same market/side.  Fetches real-time bid from
// /api/orderbook on open so the user sees the actual current sell price, not
// a cached value.  Places a limit order at that bid price (not a 1¢ sweep).

function SellModal({
  trades, selling, onConfirm, onClose,
}: {
  trades: Trade[];
  selling: boolean;
  onConfirm: (sellPriceCents: number | undefined) => void;
  onClose: () => void;
}) {
  const firstTrade = trades[0];
  const side       = firstTrade.side as "YES" | "NO";
  const ticker     = firstTrade.market_id;

  // Aggregate contracts across all fills
  const totalContracts = trades.reduce((sum, t) => {
    const entryYes   = getEntryYesPrice(t);
    const entryPrice = t.side === "YES" ? entryYes : 1 - entryYes;
    const stored = t.filled_count ?? 0;
    const count  = stored > 0 ? stored : (entryPrice > 0 ? Math.floor(t.amount_usdc / entryPrice) : 0);
    return sum + count;
  }, 0);

  const totalCostBasis = trades.reduce((sum, t) => {
    const entryYes   = getEntryYesPrice(t);
    const entryPrice = t.side === "YES" ? entryYes : 1 - entryYes;
    const stored = t.filled_count ?? 0;
    const count  = stored > 0 ? stored : (entryPrice > 0 ? Math.floor(t.amount_usdc / entryPrice) : 0);
    return sum + count * entryPrice;
  }, 0);
  const avgEntryPrice = totalContracts > 0 ? totalCostBasis / totalContracts : 0;

  // Real-time orderbook — fetched once on mount
  const [bidCents,    setBidCents]    = useState<number | null>(null);
  const [askCents,    setAskCents]    = useState<number | null>(null);
  const [bidLoading,  setBidLoading]  = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function fetchBid() {
      setBidLoading(true);
      try {
        const res  = await fetch(`/api/orderbook?ticker=${encodeURIComponent(ticker)}`, { cache: "no-store" });
        const json = await res.json();
        if (cancelled) return;
        const bid = side === "YES" ? json.yes_bid_cents : json.no_bid_cents;
        const ask = side === "YES" ? json.yes_ask_cents : json.no_ask_cents;
        setBidCents(typeof bid === "number" ? bid : null);
        setAskCents(typeof ask === "number" ? ask : null);
      } catch { /* non-fatal */ }
      finally { if (!cancelled) setBidLoading(false); }
    }
    void fetchBid();
    return () => { cancelled = true; };
  }, [ticker, side]);

  // Editable sell price — defaults to current bid once loaded
  const [priceInput, setPriceInput] = useState("");
  useEffect(() => {
    if (bidCents != null && priceInput === "") setPriceInput(String(bidCents));
  }, [bidCents]); // eslint-disable-line react-hooks/exhaustive-deps

  const parsedCents   = parseInt(priceInput, 10);
  const validPrice    = !isNaN(parsedCents) && parsedCents >= 1 && parsedCents <= 99;
  const sellPriceCents = validPrice ? parsedCents : null;
  const sellPrice      = sellPriceCents != null ? sellPriceCents / 100 : null;

  // Will this fill immediately or rest?
  // A sell rests when price > current ask (no buyer willing to pay that much).
  const willRest = askCents != null && sellPriceCents != null && sellPriceCents > askCents;

  const estProceeds = sellPrice != null ? totalContracts * sellPrice : null;
  const estPnl      = estProceeds != null ? estProceeds - totalCostBasis : null;
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
              <p className="text-slate-400 text-sm mt-0.5 leading-snug">{firstTrade.market_question}</p>
            </div>
            <button onClick={onClose} className="text-slate-500 hover:text-slate-300 text-xl leading-none mt-0.5">×</button>
          </div>
        </div>

        {/* Details grid */}
        <div className="px-5 py-4 grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">Side</p>
            <p className={`font-semibold ${side === "YES" ? "text-emerald-400" : "text-red-400"}`}>{side}</p>
          </div>
          <div>
            <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">Contracts</p>
            <p className="text-white font-semibold">{totalContracts}</p>
          </div>
          <div>
            <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">Avg Entry</p>
            <p className="text-slate-200 font-medium">{(avgEntryPrice * 100).toFixed(1)}¢</p>
          </div>
          <div>
            <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">
              Current Bid
              {askCents != null && <span className="ml-1 text-slate-600">/ Ask {askCents}¢</span>}
            </p>
            {bidLoading
              ? <p className="text-slate-500 animate-pulse">loading…</p>
              : bidCents != null
                ? <p className="text-slate-400">{bidCents}¢</p>
                : <p className="text-slate-500">—</p>}
          </div>
          <div>
            <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">Cost Basis</p>
            <p className="text-slate-200 font-medium">${totalCostBasis.toFixed(2)}</p>
          </div>
          <div>
            <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">Est. Proceeds</p>
            {estProceeds != null
              ? <p className="text-slate-200 font-medium">${estProceeds.toFixed(2)}</p>
              : <p className="text-slate-500">—</p>}
          </div>
        </div>

        {/* Sell price input */}
        <div className="px-5 pb-4">
          <p className="text-slate-500 text-xs uppercase tracking-wide mb-2">Sell Price (¢)</p>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <input
                type="number"
                min={1}
                max={99}
                value={priceInput}
                onChange={(e) => setPriceInput(e.target.value)}
                disabled={bidLoading || selling}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2.5 text-white font-semibold text-sm focus:outline-none focus:border-amber-500 disabled:opacity-50"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">¢</span>
            </div>
            {bidCents != null && (
              <button
                onClick={() => setPriceInput(String(bidCents))}
                disabled={selling}
                className="px-3 py-2.5 rounded-lg border border-slate-600 text-slate-400 hover:text-white hover:border-slate-500 text-xs transition-colors disabled:opacity-40"
              >
                Reset to bid
              </button>
            )}
          </div>
          {willRest && (
            <p className="mt-2 text-xs text-amber-400">
              ⏳ Price above current ask — order will rest until a buyer matches it.
              You can boost or cancel it from Pending Orders.
            </p>
          )}
        </div>

        {/* Est. P&L */}
        {estPnl != null && (
          <div className="px-5 pb-4">
            <div className="flex items-center justify-between bg-slate-900/50 rounded-lg px-4 py-2.5">
              <span className="text-slate-400 text-sm">Estimated P&amp;L</span>
              <span className={`font-bold text-base ${pnlColor}`}>
                {estPnl >= 0 ? "+" : ""}${estPnl.toFixed(2)}
              </span>
            </div>
          </div>
        )}

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
            onClick={() => onConfirm(sellPriceCents ?? undefined)}
            disabled={selling || bidLoading || !validPrice}
            className="flex-1 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-white font-bold transition-colors text-sm"
          >
            {selling ? "Selling…" : bidLoading ? "Loading…" : `Sell ${totalContracts} @ ${sellPriceCents ?? "?"}¢`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Mark Sold modal ───────────────────────────────────────────────────────────

function MarkSoldModal({
  trade, saving, onConfirm, onClose,
}: {
  trade:     Trade;
  saving:    boolean;
  onConfirm: (sellPriceCents: number | null) => void;
  onClose:   () => void;
}) {
  const entryYes   = getEntryYesPrice(trade);
  const entryPrice = trade.side === "YES" ? entryYes : 1 - entryYes;
  const contracts  = trade.filled_count ?? (entryPrice > 0 ? Math.floor(trade.amount_usdc / entryPrice) : 0);
  const entryCents = Math.round(entryPrice * 100);

  const [priceCentsInput, setPriceCentsInput] = useState(String(entryCents));
  const parsed = parseInt(priceCentsInput, 10);
  const validPrice = !isNaN(parsed) && parsed >= 1 && parsed <= 99;

  const estPnl: number | null = validPrice && contracts > 0 ? (() => {
    const sellProceeds = trade.side === "YES" ? parsed / 100 : 1 - parsed / 100;
    return parseFloat(((sellProceeds - entryPrice) * contracts).toFixed(2));
  })() : null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-sm bg-slate-800 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-5 pt-5 pb-4 border-b border-slate-700">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-white font-bold text-lg">Mark as Sold</h2>
              <p className="text-slate-400 text-sm mt-0.5 leading-snug">
                {getBracketLabel(trade.market_question)} · {contracts} contracts @ {entryCents}¢
              </p>
            </div>
            <button onClick={onClose} className="text-slate-500 hover:text-slate-300 text-xl leading-none mt-0.5">×</button>
          </div>
        </div>

        {/* Price input */}
        <div className="px-5 py-5 space-y-4">
          <div>
            <label className="block text-xs text-slate-500 uppercase tracking-wide mb-1.5">
              Sell price (¢) — check Kalshi trade history
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={99}
                value={priceCentsInput}
                onChange={(e) => setPriceCentsInput(e.target.value)}
                className="w-24 bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-sky-500"
                placeholder="e.g. 72"
              />
              <span className="text-slate-500 text-sm">¢  per contract</span>
            </div>
          </div>

          {estPnl != null && (
            <div className="flex items-center justify-between bg-slate-900/50 rounded-lg px-4 py-2.5">
              <span className="text-slate-400 text-sm">Estimated P&amp;L</span>
              <span className={`font-bold text-base ${estPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {estPnl >= 0 ? "+" : ""}${estPnl.toFixed(2)}
              </span>
            </div>
          )}

          <p className="text-xs text-slate-500">
            Leave the price as-is or skip it — you can update P&amp;L later. This only updates our records; the Kalshi trade already happened.
          </p>
        </div>

        {/* Buttons */}
        <div className="px-5 pb-5 flex gap-3">
          <button onClick={onClose} disabled={saving}
            className="flex-1 py-2.5 rounded-xl border border-slate-600 text-slate-300 hover:border-slate-500 hover:text-white transition-colors disabled:opacity-40 text-sm font-medium">
            Cancel
          </button>
          <button
            onClick={() => onConfirm(validPrice ? parsed : null)}
            disabled={saving}
            className="flex-1 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-white font-bold transition-colors text-sm">
            {saving ? "Saving…" : "Mark as Sold"}
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

  // Orig edge corrected for side: for NO trades, my_pct is the YES forecast so
  // we flip it to get the NO-side edge = (100 − my_pct) − NO_price.
  const origEdge = trade.side === "YES"
    ? trade.my_pct - currentCents
    : (100 - trade.my_pct) - currentCents;

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

  const newCost          = chosenCents != null ? (chosenCents / 100) * contracts : null;
  const oldCost          = entryPrice * contracts;
  const costDiff         = newCost != null ? newCost - oldCost : null;
  // Profit if the market resolves in your favour at the new price.
  // chosenCents is always the side-specific price (YES ¢ for YES, NO ¢ for NO),
  // so profit-per-contract = 1 − price regardless of side.
  const ifCorrectProfit  = chosenCents != null
    ? parseFloat((contracts * (1 - chosenCents / 100)).toFixed(2))
    : null;
  const oldIfCorrectProfit = parseFloat((contracts * (1 - entryPrice)).toFixed(2));

  // Edge at chosen price: my_pct - new_price_cents
  // Edge = forecast_for_this_side − price_paid.
  // For YES: edge = my_pct − chosenCents  (my_pct is YES probability)
  // For NO:  edge = (100 − my_pct) − chosenCents  (flip to NO probability)
  const newEdge     = chosenCents != null
    ? (trade.side === "YES" ? trade.my_pct - chosenCents : (100 - trade.my_pct) - chosenCents)
    : null;
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
            <p className={`font-semibold ${origEdge >= 10 ? "text-emerald-400" : origEdge >= 0 ? "text-sky-400" : "text-red-400"}`}>
              {origEdge > 0 ? "+" : ""}{origEdge}pt
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
              {ifCorrectProfit != null && (
                <div className="flex justify-between border-t border-slate-700/50 pt-1.5">
                  <span className="text-slate-400">🎯 If correct</span>
                  <span className="font-semibold text-sky-400">
                    +${ifCorrectProfit.toFixed(2)}
                    {ifCorrectProfit !== oldIfCorrectProfit && (
                      <span className="text-slate-500 font-normal ml-1.5">
                        (was +${oldIfCorrectProfit.toFixed(2)})
                      </span>
                    )}
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
  group, collapsed, onToggle, livePrices, positions,
}: {
  group:      TradeGroup;
  collapsed:  boolean;
  onToggle:   () => void;
  livePrices: Map<string, number>;
  today:      string;
  positions:  Position[];
}) {
  // Net P&L: realized + unrealized using position math.
  // Skip unrealized for settled positions — the market is closed.
  const realized = positions.reduce((s, p) => s + p.realizedPnl, 0);
  const unrealized = positions.reduce((sum, p) => {
    if (p.netContracts <= 0 || p.state === "SETTLED") return sum;
    const liveYes = livePrices.get(p.market_id);
    if (liveYes == null) return sum;
    const livePrice = p.side === "YES" ? liveYes : 1 - liveYes;
    return sum + p.netContracts * (livePrice - p.avgBuyPrice);
  }, 0);
  const netPnl = realized + unrealized;
  const hasMtm = positions.some((p) => p.netContracts > 0 && p.state !== "SETTLED" && livePrices.has(p.market_id));

  // Count positions
  const openCount       = positions.filter((p) => p.state === "OPEN" || p.state === "PARTIALLY_CLOSED").length;
  const settledCount    = positions.filter((p) => p.state === "SETTLED" || p.state === "CLOSED").length;
  const pendingOrderCount = positions.reduce((s, p) => s + p.pendingOrders.length, 0);

  const hasPnl  = settledCount > 0 || hasMtm;
  const showNet = hasPnl;

  const countLabel = (() => {
    const parts: string[] = [];
    if (openCount > 0) parts.push(`${openCount} open`);
    if (settledCount > 0) parts.push(`${settledCount} settled`);
    if (pendingOrderCount > 0) parts.push(`${pendingOrderCount} pending`);
    return parts.length > 0 ? parts.join(" · ") : "0 positions";
  })();

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

      {/* Right: Net P&L only */}
      {showNet && (
        <div className="shrink-0 text-right">
          <p className="text-slate-500 uppercase tracking-wide text-[10px]">
            {hasMtm ? "~Net P&L" : "Net P&L"}
          </p>
          <p className={`text-sm font-semibold ${netPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)}
          </p>
        </div>
      )}
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
  /** When true: rendered as a sub-row under a PositionGroupRow/Card */
  isSubRow?: boolean;
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
  groupMode = false, isSubRow = false,
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
    <div className={isSubRow ? "ml-3 border-l-2 border-slate-700/50" : ""}>
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
    </div>
  );
}

// ── Desktop table row ─────────────────────────────────────────────────────────

function TradeRow({ trade, liveYesPrice, today, canceling, onCancel, selling, onSell, boosting, onBoost, groupMode = false, isSubRow = false }: TradeRowProps) {
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
        className={`transition-colors cursor-pointer ${isSubRow ? "hover:bg-slate-700/30" : "hover:bg-slate-800/50"}`}
        onClick={() => setExpanded((v) => !v)}
      >
        {/* Date — hidden in groupMode */}
        {!groupMode && (
          <td className="py-3 pr-4 text-slate-400 whitespace-nowrap pl-4">
            {new Date(trade.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </td>
        )}

        {/* Market / Bracket */}
        <td className={`py-3 pr-4 max-w-[220px] ${groupMode ? (isSubRow ? "pl-8" : "pl-4") : ""}`}>
          <a href={trade.polymarket_url ?? "#"} target="_blank" rel="noopener noreferrer"
            className={`hover:text-sky-400 transition-colors line-clamp-2 leading-snug ${isSubRow ? "text-slate-400" : "text-slate-200"}`}
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

// ── PositionGroupRow / PositionGroupCard (legacy — kept for reference) ────────
// These components are superseded by PositionRow / PositionCard below.

interface PositionGroupRowProps {
  pg:         { bracket: string; side: "YES"|"NO"; trades: Trade[]; avgEdge: number; edgesVary: boolean; minEdge: number; maxEdge: number; filledContracts: number; totalContracts: number; orderStatusSummary: string; outcome: Trade["outcome"]; totalPnl: number|null; totalPotentialProfit: number|null; key: string; totalAmount: number };
  expanded:   boolean;
  onToggle:   () => void;
  livePrices: Map<string, number>;
  today:      string;
  canceling:  string | null;
  selling:    string | null;
  boosting:   string | null;
  onCancel:   (id: string) => void;
  onSell:     (t: Trade) => void;
  onBoost:    (t: Trade) => void;
}

function PositionGroupRow({
  pg, expanded, onToggle, livePrices,
}: PositionGroupRowProps) {
  const edgeColor =
    pg.avgEdge >= 25 ? "text-emerald-400" :
    pg.avgEdge >= 10 ? "text-sky-400" :
    pg.avgEdge <= -10 ? "text-red-400" : "text-slate-400";

  // Order status badge: derive a synthetic status
  const syntheticStatus: { label: string; classes: string } | null = (() => {
    switch (pg.orderStatusSummary) {
      case "filled":  return { label: "🟢 Filled",  classes: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" };
      case "partial": return { label: "🟠 Partial",  classes: "bg-orange-500/15 text-orange-300 border-orange-500/30" };
      case "resting": return { label: "🟡 Resting",  classes: "bg-yellow-500/15 text-yellow-300 border-yellow-500/30" };
      default:        return null;
    }
  })();

  // P&L: use totalPnl if available, else sum mark-to-market across trades
  const liveYesPrices = pg.trades.map((t) => livePrices.get(t.market_id));
  const anyLivePrice  = liveYesPrices.some((p) => p != null);
  const mtmSum        = anyLivePrice
    ? pg.trades.reduce((sum, t) => {
        const live = livePrices.get(t.market_id);
        if (live == null) return sum;
        const entryYes   = t.entry_yes_price ?? (t.side === "YES" ? t.market_pct / 100 : 1 - t.market_pct / 100);
        const entryPrice = t.side === "YES" ? entryYes : 1 - entryYes;
        const livePrice  = t.side === "YES" ? live : 1 - live;
        if (entryPrice <= 0) return sum;
        const isPartialOrder = (t.order_status === "resting" || t.order_status === "canceled") && (t.filled_count ?? 0) > 0;
        const amount = isPartialOrder ? t.filled_count! * entryPrice : t.amount_usdc;
        return sum + amount * (livePrice / entryPrice - 1);
      }, 0)
    : null;

  const pnlDisplay = pg.totalPnl != null ? pg.totalPnl : mtmSum;
  const pnlIsEstimate = pg.totalPnl == null && mtmSum != null;
  const pnlColor = pnlDisplay == null ? "text-slate-600"
    : pnlDisplay >= 0 ? "text-emerald-400" : "text-red-400";

  const sig = deriveTradeSignal(pg.side, pg.avgEdge);

  return (
    <tr
      className="bg-slate-800/30 hover:bg-slate-800/60 cursor-pointer transition-colors"
      onClick={onToggle}
    >
      {/* Bracket */}
      <td className="py-3 pr-4 pl-4 max-w-[220px]">
        <div className="flex items-center gap-1.5">
          <span className={`text-slate-500 text-base leading-none transition-transform duration-150 shrink-0 ${expanded ? "rotate-90" : ""}`}>
            ›
          </span>
          <span className="text-slate-200 line-clamp-2 leading-snug">{pg.bracket}</span>
        </div>
      </td>

      {/* Side */}
      <td className="py-3 pr-4">
        <span className={`font-semibold ${pg.side === "YES" ? "text-emerald-400" : "text-red-400"}`}>
          {pg.side}
        </span>
      </td>

      {/* Amount */}
      <td className="py-3 pr-4 whitespace-nowrap">
        <span className="text-slate-200">${pg.totalAmount.toFixed(2)}</span>
        <p className="text-xs text-slate-500 mt-0.5">{pg.trades.length} fills</p>
      </td>

      {/* Signal */}
      <td className="py-3 pr-4">
        <SignalBadge signal={sig} title={signalTooltip(sig, pg.side, pg.avgEdge)} />
      </td>

      {/* Edge */}
      <td className={`py-3 pr-4 font-semibold ${edgeColor} whitespace-nowrap`}>
        {pg.avgEdge > 0 ? "+" : ""}{pg.avgEdge}
        {pg.edgesVary && (
          <p className="text-xs text-slate-500 font-normal mt-0.5">({pg.minEdge}..{pg.maxEdge})</p>
        )}
      </td>

      {/* Order status */}
      <td className="py-3 pr-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-col gap-1 items-start">
          {syntheticStatus ? (
            <>
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${syntheticStatus.classes}`}>
                {syntheticStatus.label}
              </span>
              {pg.orderStatusSummary === "partial" && (
                <span className="text-xs text-slate-500">
                  {pg.filledContracts} of {pg.totalContracts}
                </span>
              )}
            </>
          ) : (
            <span className="text-xs text-slate-400">Mixed</span>
          )}
        </div>
      </td>

      {/* Outcome */}
      <td className="py-3 pr-4" onClick={(e) => e.stopPropagation()}>
        <OutcomeBadge outcome={pg.outcome} />
      </td>

      {/* P&L */}
      <td className="py-3 whitespace-nowrap">
        <div className="flex flex-col">
          {pnlDisplay != null ? (
            <span className={`font-semibold ${pnlColor}`}>
              {pnlIsEstimate && "~"}{pnlDisplay >= 0 ? "+" : ""}${pnlDisplay.toFixed(2)}
            </span>
          ) : (
            <span className="text-slate-600">—</span>
          )}
          {pg.totalPotentialProfit != null && (
            <span className="text-xs text-slate-500 mt-0.5">
              🎯 +${pg.totalPotentialProfit.toFixed(2)} if correct
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}

// ── PositionGroupCard (mobile) ────────────────────────────────────────────────

function PositionGroupCard({
  pg, expanded, onToggle, livePrices,
}: PositionGroupRowProps) {
  const edgeColor =
    pg.avgEdge >= 25 ? "text-emerald-400" :
    pg.avgEdge >= 10 ? "text-sky-400" :
    pg.avgEdge <= -10 ? "text-red-400" : "text-slate-400";

  const liveYesPrices = pg.trades.map((t) => livePrices.get(t.market_id));
  const anyLivePrice  = liveYesPrices.some((p) => p != null);
  const mtmSum        = anyLivePrice
    ? pg.trades.reduce((sum, t) => {
        const live = livePrices.get(t.market_id);
        if (live == null) return sum;
        const entryYes   = t.entry_yes_price ?? (t.side === "YES" ? t.market_pct / 100 : 1 - t.market_pct / 100);
        const entryPrice = t.side === "YES" ? entryYes : 1 - entryYes;
        const livePrice  = t.side === "YES" ? live : 1 - live;
        if (entryPrice <= 0) return sum;
        const isPartialOrder = (t.order_status === "resting" || t.order_status === "canceled") && (t.filled_count ?? 0) > 0;
        const amount = isPartialOrder ? t.filled_count! * entryPrice : t.amount_usdc;
        return sum + amount * (livePrice / entryPrice - 1);
      }, 0)
    : null;

  const pnlDisplay   = pg.totalPnl != null ? pg.totalPnl : mtmSum;
  const pnlIsEstimate = pg.totalPnl == null && mtmSum != null;
  const pnlColor     = pnlDisplay == null ? ""
    : pnlDisplay >= 0 ? "text-emerald-400" : "text-red-400";

  const sig = deriveTradeSignal(pg.side, pg.avgEdge);

  return (
    <div
      className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden cursor-pointer select-none"
      onClick={onToggle}
    >
      <div className="p-4 space-y-3">
        {/* Row 1: bracket + chevron */}
        <div className="flex items-start gap-2">
          <span className="flex-1 text-slate-200 text-sm leading-snug font-medium">
            {pg.bracket}
          </span>
          <span className={`shrink-0 text-slate-500 text-base leading-none transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}>
            ›
          </span>
        </div>

        {/* Row 2: badges + P&L */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm min-w-0">
            <span className={`font-semibold ${pg.side === "YES" ? "text-emerald-400" : "text-red-400"}`}>
              {pg.side}
            </span>
            <span className="text-slate-300">${pg.totalAmount.toFixed(2)}</span>
            <span className="text-xs text-slate-500">{pg.trades.length} fills</span>
            <SignalBadge signal={sig} title={signalTooltip(sig, pg.side, pg.avgEdge)} />
            <span className={`text-xs font-semibold ${edgeColor}`}>
              {pg.avgEdge > 0 ? "+" : ""}{pg.avgEdge}{pg.edgesVary ? ` (${pg.minEdge}..${pg.maxEdge})` : ""}
            </span>
          </div>
          <div className="shrink-0 text-right">
            {pnlDisplay != null ? (
              <span className={`font-medium ${pnlColor}`}>
                {pnlIsEstimate && "~"}{pnlDisplay >= 0 ? "+" : ""}${pnlDisplay.toFixed(2)}
              </span>
            ) : (
              <span className="text-slate-600 text-sm">—</span>
            )}
            {pg.totalPotentialProfit != null && (
              <p className="text-[10px] text-slate-500 mt-0.5">
                🎯 +${pg.totalPotentialProfit.toFixed(2)} if correct
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Outcome badge */}
      <div className="px-4 pb-3">
        <OutcomeBadge outcome={pg.outcome} />
      </div>
    </div>
  );
}

// ── Position-based components ─────────────────────────────────────────────────

interface PositionRowProps {
  pos:          Position;
  expanded:     boolean;
  onToggle:     () => void;
  hasChildren?: boolean;  // false → hide chevron and make row non-interactive
  subRow?:      boolean;  // true → inside a bracket group, hide bracket label
  livePrices:   Map<string, number>;
  canceling:    string | null;
  selling:      string | null;
  boosting:     string | null;
  onCancel:     (id: string) => void;
  onSell:       (fills: Trade[]) => void;  // all sellable fills for this position
  onBoost:      (t: Trade) => void;
}

function StateBadge({ state, firstFill }: { state: PositionState; firstFill?: Trade }) {
  if (state === "SETTLED" && firstFill) {
    return <OutcomeBadge outcome={firstFill.outcome} />;
  }
  const map: Record<PositionState, { label: string; classes: string }> = {
    OPEN:             { label: "🟢 Open",    classes: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
    CLOSED:           { label: "⚪ Closed",  classes: "bg-slate-500/20 text-slate-400 border-slate-500/30" },
    PARTIALLY_CLOSED: { label: "🟠 Partial", classes: "bg-orange-500/15 text-orange-300 border-orange-500/30" },
    SETTLED:          { label: "✓ Settled",  classes: "bg-slate-500/20 text-slate-400 border-slate-500/30" },
  };
  const { label, classes } = map[state];
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${classes}`}>
      {label}
    </span>
  );
}

function PositionSummaryText({ pos, mobile = false }: { pos: Position; mobile?: boolean }) {
  const sizeCls  = mobile ? "text-sm" : "";
  // contractsBought only counts non-sold fills; for a fully-closed position
  // all fills are "sold" so contractsBought is 0. Fall back to contractsSold.
  const contracts = pos.contractsBought || pos.contractsSold;
  const cost      = contracts * pos.avgBuyPrice;

  // All states show Cost + contracts — matches open-trade display
  return (
    <span className={sizeCls}>
      <span className="text-slate-200 font-medium">Cost ${cost.toFixed(2)}</span>
      <span className="text-slate-500 ml-1.5">· {contracts} contracts @ {(pos.avgBuyPrice * 100).toFixed(1)}¢ avg</span>
    </span>
  );
}

// ── Desktop position row ──────────────────────────────────────────────────────

function PositionRow({ pos, expanded, onToggle, hasChildren = true, subRow = false, livePrices, canceling, selling, boosting, onCancel, onSell, onBoost }: PositionRowProps) {
  const liveYes    = livePrices.get(pos.market_id);
  const livePrice  = liveYes != null ? (pos.side === "YES" ? liveYes : 1 - liveYes) : null;

  // Settled positions have a definitive realized P&L — don't add a live-price
  // estimate on top (market is closed, remaining price is meaningless).
  const unrealized = (livePrice != null && pos.netContracts > 0 && pos.state !== "SETTLED")
    ? pos.netContracts * (livePrice - pos.avgBuyPrice)
    : null;
  const totalPnl   = pos.realizedPnl + (unrealized ?? 0);
  const hasPnl     = pos.realizedPnl !== 0 || unrealized != null;
  const pnlPending = !hasPnl &&
    (pos.state === "OPEN" || pos.state === "PARTIALLY_CLOSED") &&
    pos.fills.some((t) => t.outcome === "sold" && t.pnl == null);
  const pnlColor   = totalPnl >= 0 ? "text-emerald-400" : "text-red-400";
  const isEstimate = unrealized != null;

  // Sell: show whenever there's at least one sellable fill
  const sellableFills = pos.fills.filter((t) => isSellable(t));

  return (
    <tr
      className={`bg-slate-800/20 transition-colors ${hasChildren ? "hover:bg-slate-800/50 cursor-pointer" : ""}`}
      onClick={hasChildren ? onToggle : undefined}
    >
      {/* Bracket */}
      <td className="py-3 pr-4 pl-4 max-w-[220px]">
        <div className="flex items-center gap-1.5">
          {hasChildren && (
            <span className={`text-slate-500 text-base leading-none transition-transform duration-150 shrink-0 ${expanded ? "rotate-90" : ""}`}>
              ›
            </span>
          )}
          {!subRow && <span className="text-slate-200 line-clamp-2 leading-snug">{pos.bracket}</span>}
        </div>
      </td>

      {/* Side */}
      <td className="py-3 pr-4">
        <span className={`font-semibold ${pos.side === "YES" ? "text-emerald-400" : "text-red-400"}`}>
          {pos.side}
        </span>
      </td>

      {/* State */}
      <td className="py-3 pr-4" onClick={(e) => e.stopPropagation()}>
        <StateBadge state={pos.state} firstFill={pos.fills.find((t) => t.outcome === "win" || t.outcome === "loss") ?? pos.fills[0]} />
      </td>

      {/* Position summary */}
      <td className="py-3 pr-4">
        <PositionSummaryText pos={pos} />
      </td>

      {/* P&L — data only, no action buttons */}
      <td className="py-3 pr-4 whitespace-nowrap">
        <div className="flex flex-col">
          {hasPnl ? (
            <span className={`font-semibold ${pnlColor}`}>
              {isEstimate && "~"}{totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
            </span>
          ) : pnlPending ? (
            <span className="text-slate-500 text-sm">updating…</span>
          ) : (
            <span className="text-slate-600">—</span>
          )}
          {(pos.state === "OPEN" || pos.state === "PARTIALLY_CLOSED") && (
            <span className="text-sm font-semibold text-sky-400 mt-1">
              🎯 {pos.ifCorrectPayout >= 0 ? "+" : "–"}${Math.abs(pos.ifCorrectPayout).toFixed(2)}
              <span className="text-xs font-normal text-slate-500 ml-1">if correct</span>
            </span>
          )}
        </div>
      </td>

      {/* Action — only for open positions */}
      <td className="py-3 pr-4 whitespace-nowrap text-right" onClick={(e) => e.stopPropagation()}>
        {sellableFills.length > 0 && (
          <ActionButton
            variant="sell"
            onClick={(e) => { e.stopPropagation(); onSell(sellableFills); }}
            loading={sellableFills.some((t) => selling === t.id)}
            label="Sell"
            loadingLabel="Selling…"
          />
        )}
      </td>
    </tr>
  );
}

// ── Desktop fill sub-row ─────────────────────────────────────────────────────

interface FillSubRowProps {
  trade:        Trade;
  liveYesPrice?: number;
  canceling:    boolean;
  selling:      boolean;
  boosting:     boolean;
  onCancel:     () => void;
  onSell:       () => void;
  onBoost:      () => void;
}

function FillSubRow({ trade, onSell: _onSell, onBoost: _onBoost, onCancel: _onCancel }: FillSubRowProps) {
  // Fill rows are read-only audit trail — no action buttons
  void _onSell; void _onBoost; void _onCancel;
  const entryYes   = modelGetEntryYesPrice(trade);
  const entryPrice = trade.side === "YES" ? entryYes : 1 - entryYes;
  const contracts  = getContractsForFill(trade);
  const timeStr    = new Date(trade.created_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const isSell     = trade.outcome === "sold";
  const pnlColor   = trade.pnl == null ? "" : trade.pnl >= 0 ? "text-emerald-400" : "text-red-400";
  const displayEdge = trade.side === "NO" ? -trade.edge : trade.edge;

  return (
    <tr className="bg-slate-900/40 hover:bg-slate-900/60 transition-colors">
      {/* Time + BUY/SOLD badge */}
      <td className="py-2 pr-4 pl-6 text-slate-500 text-xs whitespace-nowrap border-l-2 border-slate-600/40">
        {timeStr}
        <span className={`ml-2 px-1.5 py-0.5 rounded text-[10px] font-semibold ${isSell ? "bg-amber-500/15 text-amber-400" : "bg-slate-700 text-slate-300"}`}>
          {isSell ? "SOLD" : "BUY"}
        </span>
      </td>

      {/* Side */}
      <td className="py-2 pr-4">
        <span className={`text-xs font-semibold ${trade.side === "YES" ? "text-emerald-400/70" : "text-red-400/70"}`}>
          {trade.side}
        </span>
      </td>

      {/* Order status */}
      <td className="py-2 pr-4">
        <OrderStatusBadge status={trade.order_status} filledCount={trade.filled_count} />
      </td>

      {/* Position detail */}
      <td className="py-2 pr-4 text-xs text-slate-400">
        <span>{contracts} contracts @ {(entryPrice * 100).toFixed(1)}¢</span>
        {trade.signal && (
          <span className="ml-2 text-slate-600">
            {trade.signal} {displayEdge > 0 ? "+" : ""}{displayEdge}pt
          </span>
        )}
      </td>

      {/* P&L */}
      <td className="py-2 pr-4 whitespace-nowrap">
        {trade.pnl != null && (
          <span className={`text-xs font-semibold ${pnlColor}`}>
            {trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}
          </span>
        )}
      </td>

      {/* Action — fill rows are read-only, no buttons */}
      <td className="py-2" />
    </tr>
  );
}

// ── Desktop pending order row ────────────────────────────────────────────────

interface PendingOrderRowProps {
  trade:     Trade;
  canceling: boolean;
  boosting:  boolean;
  onCancel:  () => void;
  onBoost:   () => void;
}

function PendingOrderRow({ trade, canceling, boosting, onCancel, onBoost }: PendingOrderRowProps) {
  const entryYes   = modelGetEntryYesPrice(trade);
  const entryPrice = trade.side === "YES" ? entryYes : 1 - entryYes;
  const contracts  = getContractsForFill(trade);
  const bracket    = modelGetBracketLabel(trade.market_question);
  const showBoost  = isBoostable(trade);
  const showCancel = trade.kalshi_order_id != null;
  const filledCount    = trade.filled_count ?? 0;
  const remainingCount = trade.remaining_count ?? 0;
  const totalCount     = filledCount + remainingCount;
  // A resting sell has existing fills (the buy) but order_status=resting (sell order resting)
  // remaining_count === -1 is a sentinel set by sell-position when a limit sell
  // order doesn't immediately fill.  Partial buy orders have remaining_count > 0.
  const isSellOrder = filledCount > 0 && trade.order_status === "resting" && (trade.remaining_count ?? 0) === -1;

  return (
    <tr className="bg-yellow-500/5 hover:bg-yellow-500/10 transition-colors">
      {/* Bracket */}
      <td className="py-2 pr-4 pl-4 text-slate-300 text-sm">{bracket}</td>

      {/* Side */}
      <td className="py-2 pr-4">
        <span className={`font-semibold text-sm ${trade.side === "YES" ? "text-emerald-400" : "text-red-400"}`}>
          {trade.side}
        </span>
      </td>

      {/* Status */}
      <td className="py-2 pr-4">
        <div className="flex items-center gap-1.5">
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${isSellOrder ? "bg-amber-500/20 text-amber-400" : "bg-sky-500/20 text-sky-400"}`}>
            {isSellOrder ? "SELL" : "BUY"}
          </span>
          <OrderStatusBadge status={trade.order_status} filledCount={trade.filled_count} />
        </div>
      </td>

      {/* Position detail */}
      <td className="py-2 pr-4 text-xs text-slate-400">
        {isSellOrder ? (
          <span>{filledCount} contracts @ {(entryPrice * 100).toFixed(1)}¢ limit</span>
        ) : filledCount > 0 ? (
          // Partial fill: show remaining if known, otherwise just filled/total
          <span>
            {remainingCount > 0 ? `${remainingCount} remaining` : "remaining contracts"}
            {" "}@ {(entryPrice * 100).toFixed(1)}¢ limit
            <span className="ml-2 text-slate-500">({filledCount}{totalCount > filledCount ? `/${totalCount}` : ""} filled)</span>
          </span>
        ) : (
          <span>{contracts} contracts @ {(entryPrice * 100).toFixed(1)}¢ limit</span>
        )}
      </td>

      {/* P&L — empty for pending orders */}
      <td className="py-2 pr-4" />

      {/* Actions */}
      <td className="py-2 pr-4 whitespace-nowrap text-right" onClick={(e) => e.stopPropagation()}>
        <div className="flex gap-1 flex-wrap justify-end">
          {showBoost && (
            <ActionButton variant="boost" onClick={(e) => { e.stopPropagation(); onBoost(); }}
              loading={boosting} label="Boost ↑" loadingLabel="Boosting…" />
          )}
          {showCancel && (
            <ActionButton variant="cancel" onClick={(e) => { e.stopPropagation(); onCancel(); }}
              loading={canceling} label="Cancel" loadingLabel="Canceling…" />
          )}
        </div>
      </td>
    </tr>
  );
}

// ── Mobile position card ─────────────────────────────────────────────────────

function PositionCard({ pos, expanded, onToggle, hasChildren = true, livePrices, selling, onSell }: PositionRowProps) {
  const liveYes    = livePrices.get(pos.market_id);
  const livePrice  = liveYes != null ? (pos.side === "YES" ? liveYes : 1 - liveYes) : null;
  // Settled positions have a definitive realized P&L — don't add a live-price
  // estimate on top (market is closed, remaining price is meaningless).
  const unrealized = (livePrice != null && pos.netContracts > 0 && pos.state !== "SETTLED")
    ? pos.netContracts * (livePrice - pos.avgBuyPrice)
    : null;
  const totalPnl   = pos.realizedPnl + (unrealized ?? 0);
  const hasPnl     = pos.realizedPnl !== 0 || unrealized != null;
  const pnlPending = !hasPnl &&
    (pos.state === "OPEN" || pos.state === "PARTIALLY_CLOSED") &&
    pos.fills.some((t) => t.outcome === "sold" && t.pnl == null);
  const pnlColor   = totalPnl >= 0 ? "text-emerald-400" : "text-red-400";
  const isEstimate = unrealized != null;
  const isOpen     = pos.state === "OPEN" || pos.state === "PARTIALLY_CLOSED";

  const sellableFills = pos.fills.filter((t) => isSellable(t));

  return (
    <div
      className={`bg-slate-800 border border-slate-700 rounded-xl overflow-hidden select-none ${hasChildren ? "cursor-pointer" : ""}`}
      onClick={hasChildren ? onToggle : undefined}
    >
      <div className="p-4 space-y-2">
        {/* Line 1: bracket · side · state + chevron */}
        <div className="flex items-start gap-2">
          <div className="flex-1 flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
            <span className="text-slate-200 text-sm font-medium leading-snug">{pos.bracket}</span>
            <span className={`font-semibold text-sm ${pos.side === "YES" ? "text-emerald-400" : "text-red-400"}`}>
              {pos.side}
            </span>
            <StateBadge state={pos.state} firstFill={pos.fills.find((t) => t.outcome === "win" || t.outcome === "loss") ?? pos.fills[0]} />
          </div>
          {hasChildren && (
            <span className={`shrink-0 text-slate-500 text-base leading-none transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}>›</span>
          )}
        </div>

        {/* Line 2: cost + contracts */}
        <div className="text-xs text-slate-400">
          <PositionSummaryText pos={pos} mobile />
        </div>

        {/* Line 3: current P&L · if correct */}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span className="text-sm font-semibold">
            {hasPnl ? (
              <span className={pnlColor}>
                {isEstimate && "~"}{totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
              </span>
            ) : pnlPending ? (
              <span className="text-slate-500">updating…</span>
            ) : (
              <span className="text-slate-600">—</span>
            )}
          </span>
          {isOpen && (
            <span className="text-sm font-semibold text-sky-400">
              🎯 {pos.ifCorrectPayout >= 0 ? "+" : "–"}${Math.abs(pos.ifCorrectPayout).toFixed(2)}
              <span className="text-xs font-normal text-slate-500 ml-1">if correct</span>
            </span>
          )}
        </div>

        {/* Line 4: action buttons — only for open positions */}
        {sellableFills.length > 0 && (
          <div className="flex gap-2 pt-1" onClick={(e) => e.stopPropagation()}>
            <ActionButton variant="sell"
              onClick={(e) => { e.stopPropagation(); onSell(sellableFills); }}
              loading={sellableFills.some((t) => selling === t.id)}
              label="Sell" loadingLabel="Selling…" />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Mobile fill sub-card ─────────────────────────────────────────────────────

function FillSubCard({ trade, onSell: _onSell, onBoost: _onBoost, onCancel: _onCancel }: FillSubRowProps) {
  // Fill rows are read-only audit trail — no action buttons
  void _onSell; void _onBoost; void _onCancel;
  const entryYes   = modelGetEntryYesPrice(trade);
  const entryPrice = trade.side === "YES" ? entryYes : 1 - entryYes;
  const contracts  = getContractsForFill(trade);
  const timeStr    = new Date(trade.created_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const isSell     = trade.outcome === "sold";
  const pnlColor    = trade.pnl == null ? "" : trade.pnl >= 0 ? "text-emerald-400" : "text-red-400";
  const displayEdge = trade.side === "NO" ? -trade.edge : trade.edge;

  return (
    <div className="ml-3 border-l-2 border-slate-700/50">
      <div className="bg-slate-900/40 border border-slate-700/30 rounded-lg mx-1 my-1 p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-500">{timeStr}</span>
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${isSell ? "bg-amber-500/15 text-amber-400" : "bg-slate-700 text-slate-300"}`}>
              {isSell ? "SOLD" : "BUY"}
            </span>
            <OrderStatusBadge status={trade.order_status} filledCount={trade.filled_count} />
          </div>
          {trade.pnl != null && (
            <span className={`text-xs font-semibold ${pnlColor}`}>
              {trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}
            </span>
          )}
        </div>
        <div className="text-xs text-slate-400">
          {contracts} contracts @ {(entryPrice * 100).toFixed(1)}¢
          {trade.edge !== 0 && (
            <span className="ml-2 text-slate-600">{trade.signal} {displayEdge > 0 ? "+" : ""}{displayEdge}pt</span>
          )}
        </div>
        {/* no action buttons — fill rows are read-only audit trail */}
      </div>
    </div>
  );
}

// ── Mobile pending order card ────────────────────────────────────────────────

function PendingOrderCard({ trade, canceling, boosting, onCancel, onBoost }: PendingOrderRowProps) {
  const entryYes   = modelGetEntryYesPrice(trade);
  const entryPrice = trade.side === "YES" ? entryYes : 1 - entryYes;
  const contracts  = getContractsForFill(trade);
  const bracket    = modelGetBracketLabel(trade.market_question);
  const showBoost  = isBoostable(trade);
  const showCancel = trade.kalshi_order_id != null;
  const filledCount    = trade.filled_count ?? 0;
  const remainingCount = trade.remaining_count ?? 0;
  const totalCount     = filledCount + remainingCount;
  const isSellOrder    = filledCount > 0 && trade.order_status === "resting";

  return (
    <div className="bg-yellow-500/5 border border-yellow-500/20 rounded-xl p-3 my-1 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`font-semibold text-sm ${trade.side === "YES" ? "text-emerald-400" : "text-red-400"}`}>
            {trade.side}
          </span>
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${isSellOrder ? "bg-amber-500/20 text-amber-400" : "bg-sky-500/20 text-sky-400"}`}>
            {isSellOrder ? "SELL" : "BUY"}
          </span>
          <span className="text-slate-300 text-sm">{bracket}</span>
        </div>
        <OrderStatusBadge status={trade.order_status} filledCount={trade.filled_count} />
      </div>
      <div className="text-xs text-slate-400">
        {isSellOrder ? (
          <>{filledCount} contracts @ {(entryPrice * 100).toFixed(1)}¢ limit</>
        ) : filledCount > 0 ? (
          <>
            {remainingCount > 0 ? `${remainingCount} remaining` : "remaining contracts"}
            {" "}@ {(entryPrice * 100).toFixed(1)}¢ limit
            <span className="ml-2 text-slate-500">({filledCount}{totalCount > filledCount ? `/${totalCount}` : ""} filled)</span>
          </>
        ) : (
          <>{contracts} contracts @ {(entryPrice * 100).toFixed(1)}¢ limit</>
        )}
      </div>
      {(showBoost || showCancel) && (
        <div className="flex gap-1 flex-wrap">
          {showBoost && (
            <ActionButton variant="boost" onClick={(e) => { e.stopPropagation(); onBoost(); }}
              loading={boosting} label="Boost ↑" loadingLabel="Boosting…" />
          )}
          {showCancel && (
            <ActionButton variant="cancel" onClick={(e) => { e.stopPropagation(); onCancel(); }}
              loading={canceling} label="Cancel" loadingLabel="Canceling…" />
          )}
        </div>
      )}
    </div>
  );
}
