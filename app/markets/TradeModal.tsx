"use client";

import { useState, useEffect } from "react";
import type { MarketWithEdge } from "@/lib/types";
import SignalBadge from "@/components/SignalBadge";

interface Props {
  market:       MarketWithEdge;
  initialSide?: "YES" | "NO";
  onClose:      () => void;
  onConfirm:    () => void;
}

type Status = "idle" | "placing" | "success" | "error";

const SERIES_SLUGS: Record<string, string> = {
  kxhighphil:   "highest-temperature-in-philadelphia",
  kxlowtphil:   "lowest-temperature-in-philadelphia",
  kxprecipphil: "precipitation-in-philadelphia",
};

function buildKalshiUrl(marketId: string): string {
  const series = marketId.split("-")[0].toLowerCase();
  const slug   = SERIES_SLUGS[series] ?? series;
  return `https://kalshi.com/markets/${series}/${slug}/${marketId.toLowerCase()}`;
}

export default function TradeModal({ market, initialSide = "YES", onClose, onConfirm }: Props) {
  const [side, setSide]     = useState<"YES" | "NO">(initialSide);
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError]   = useState<string | null>(null);
  const [result, setResult] = useState<{
    order_id: string | null;
    count:    number;
    price:    number;
    demo:     boolean;
  } | null>(null);

  // ── Live orderbook ─────────────────────────────────────────────────────────
  const [bidCents,     setBidCents]     = useState<number | null>(null);
  const [askCents,     setAskCents]     = useState<number | null>(null);
  const [obLoading,    setObLoading]    = useState(true);
  const [priceInput,   setPriceInput]   = useState("");

  useEffect(() => {
    let cancelled = false;
    async function fetchOb() {
      setObLoading(true);
      try {
        const res  = await fetch(`/api/orderbook?ticker=${encodeURIComponent(market.market_id)}`, { cache: "no-store" });
        const json = await res.json();
        if (cancelled) return;
        const bid = side === "YES" ? json.yes_bid_cents : json.no_bid_cents;
        const ask = side === "YES" ? json.yes_ask_cents : json.no_ask_cents;
        setBidCents(typeof bid === "number" ? bid : null);
        setAskCents(typeof ask === "number" ? ask : null);
        // Default to ask so the order fills immediately
        if (ask != null && priceInput === "") setPriceInput(String(ask));
      } catch { /* non-fatal */ }
      finally { if (!cancelled) setObLoading(false); }
    }
    void fetchOb();
    return () => { cancelled = true; };
  // Re-fetch when side changes; reset price input so it picks up new ask
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market.market_id, side]);

  // Reset price when side changes so the new ask is used as default
  useEffect(() => { setPriceInput(""); }, [side]);

  const parsedCents  = parseInt(priceInput, 10);
  const validPrice   = !isNaN(parsedCents) && parsedCents >= 1 && parsedCents <= 99;
  const limitPrice   = validPrice ? parsedCents / 100 : (side === "YES" ? market.yes_price : 1 - market.yes_price);

  const usdc      = parseFloat(amount) || 0;
  const shares    = limitPrice > 0 ? usdc / limitPrice : 0;
  const maxProfit = shares - usdc;

  // Fill hint: order fills immediately when price >= ask
  const fillsNow = askCents != null && validPrice && parsedCents >= askCents;
  const rests    = askCents != null && validPrice && parsedCents < askCents;

  function nudgePrice(delta: number) {
    const current = parseInt(priceInput, 10);
    const base = isNaN(current) ? (askCents ?? Math.round(limitPrice * 100)) : current;
    const next = Math.min(99, Math.max(1, base + delta));
    setPriceInput(String(next));
  }

  const kalshiUrl = buildKalshiUrl(market.market_id);

  async function handlePlace() {
    if (!usdc || usdc <= 0) { setError("Enter a valid USDC amount."); return; }
    if (!validPrice)        { setError("Enter a valid price (1–99¢)."); return; }
    setStatus("placing");
    setError(null);

    try {
      const res  = await fetch("/api/place-trade", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker:          market.market_id,
          side,
          amount_dollars:  usdc,
          limit_price:     limitPrice,
          market_question: market.question,
          target_date:     market.end_date,
          market_pct:      market.market_pct,
          my_pct:          market.my_pct,
          edge:            market.edge,
          signal:          market.signal,
        }),
      });
      const json = await res.json();

      if (!res.ok) {
        setError(json.error ?? "Order failed.");
        setStatus("error");
        return;
      }

      setResult({ order_id: json.order_id, count: json.count, price: json.price_dollars, demo: !!json.demo });
      setStatus("success");
    } catch (err) {
      setError(String(err));
      setStatus("error");
    }
  }

  // ── Success screen ─────────────────────────────────────────────────────────
  if (status === "success" && result) {
    return (
      <ModalShell onClose={onClose}>
        <div className="p-8 text-center space-y-4">
          <p className="text-5xl">✅</p>
          <div>
            <div className="flex items-center justify-center gap-2">
              <p className="text-white font-bold text-lg">Order Placed!</p>
              {result.demo && (
                <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30">
                  DEMO
                </span>
              )}
            </div>
            <p className="text-slate-400 text-sm mt-1">
              {result.count} contract{result.count !== 1 ? "s" : ""} ·{" "}
              {(result.price * 100).toFixed(0)}¢ each · ${usdc.toFixed(2)} deployed
            </p>
          </div>
          {result.order_id && (
            <p className="text-xs text-slate-500 font-mono bg-slate-700/60 rounded-lg px-3 py-1.5 break-all">
              Order ID: {result.order_id}
            </p>
          )}
          <div className="flex gap-3 pt-2">
            <a href={kalshiUrl} target="_blank" rel="noopener noreferrer"
              className="flex-1 py-2 rounded-xl border border-slate-600 text-slate-300 text-sm font-medium hover:bg-slate-700 transition-colors text-center">
              View on Kalshi ↗
            </a>
            <button onClick={onClose}
              className="flex-1 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold transition-colors">
              Done
            </button>
          </div>
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell onClose={onClose}>
      {/* Header */}
      <div className="p-6 border-b border-slate-700">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-white font-semibold text-base leading-snug">{market.question}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors shrink-0 mt-0.5">✕</button>
        </div>
        <div className="flex gap-2 mt-3">
          <SignalBadge signal={market.signal} />
          <span className="text-xs text-slate-400 bg-slate-700 px-2 py-0.5 rounded">
            Edge: {market.edge > 0 ? "+" : ""}{market.edge}pts
          </span>
        </div>
      </div>

      {/* Body */}
      <div className="p-6 space-y-5">
        {/* Side selector */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">Side</label>
          <div className="flex gap-2">
            {(["YES", "NO"] as const).map((s) => (
              <button key={s} onClick={() => setSide(s)}
                className={`flex-1 py-2 rounded-lg text-sm font-semibold border transition-colors ${
                  side === s
                    ? s === "YES"
                      ? "bg-emerald-500/20 border-emerald-500 text-emerald-400"
                      : "bg-red-500/20 border-red-500 text-red-400"
                    : "bg-slate-700 border-slate-600 text-slate-400 hover:border-slate-500"
                }`}>
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* Amount */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">Amount (USDC)</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
            <input type="number" min="0" step="1" value={amount}
              onChange={(e) => setAmount(e.target.value)} placeholder="100"
              className="w-full bg-slate-700 border border-slate-600 rounded-lg pl-7 pr-16 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent" />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs">USDC</span>
          </div>
        </div>

        {/* Limit price */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-slate-300">
              Limit Price ({side})
            </label>
            {!obLoading && bidCents != null && askCents != null && (
              <span className="text-xs text-slate-500">
                Bid <span className="text-slate-400">{bidCents}¢</span>
                <span className="mx-1.5 text-slate-600">/</span>
                Ask <span className="text-slate-400">{askCents}¢</span>
              </span>
            )}
            {obLoading && (
              <span className="text-xs text-slate-500 animate-pulse">loading orderbook…</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => nudgePrice(-1)}
              disabled={obLoading || status === "placing"}
              className="w-9 h-9 flex items-center justify-center rounded-lg border border-slate-600 text-slate-300 hover:border-slate-400 hover:text-white transition-colors disabled:opacity-40 text-lg font-medium"
            >
              −
            </button>
            <div className="relative flex-1">
              <input
                type="number"
                min={1}
                max={99}
                value={priceInput}
                onChange={(e) => setPriceInput(e.target.value)}
                disabled={obLoading || status === "placing"}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm text-center font-semibold focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent disabled:opacity-50"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm pointer-events-none">¢</span>
            </div>
            <button
              onClick={() => nudgePrice(1)}
              disabled={obLoading || status === "placing"}
              className="w-9 h-9 flex items-center justify-center rounded-lg border border-slate-600 text-slate-300 hover:border-slate-400 hover:text-white transition-colors disabled:opacity-40 text-lg font-medium"
            >
              +
            </button>
            {askCents != null && (
              <button
                onClick={() => setPriceInput(String(askCents))}
                disabled={status === "placing"}
                className="px-2.5 py-2 rounded-lg border border-slate-600 text-slate-400 hover:text-white hover:border-slate-500 text-xs transition-colors disabled:opacity-40 whitespace-nowrap"
              >
                Ask
              </button>
            )}
          </div>
          {/* Fill hint */}
          {fillsNow && (
            <p className="mt-1.5 text-xs text-emerald-400">
              ✓ At or above ask — order should fill immediately.
            </p>
          )}
          {rests && (
            <p className="mt-1.5 text-xs text-amber-400">
              ⏳ Below ask — order will rest until a seller matches it.
            </p>
          )}
        </div>

        {/* Stats */}
        <div className="bg-slate-700/50 rounded-xl p-4 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-slate-400">Contracts</span>
            <span className="text-white">{shares > 0 ? Math.floor(shares).toLocaleString() : "—"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Market %</span>
            <span className="text-white">{market.market_pct}%</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Our Forecast %</span>
            <span className="text-white">{market.my_pct}%</span>
          </div>
          <div className="border-t border-slate-600 pt-2 flex justify-between font-semibold">
            <span className="text-slate-300">Max Profit</span>
            <span className="text-emerald-400">{maxProfit > 0 ? `+$${maxProfit.toFixed(2)}` : "—"}</span>
          </div>
        </div>

        {/* Error state */}
        {status === "error" && error && (
          <div className="space-y-3">
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-red-400 text-sm">
              {error}
            </div>
            <a href={kalshiUrl} target="_blank" rel="noopener noreferrer"
              className="block w-full text-center py-2 rounded-lg border border-slate-600 text-slate-300 text-sm hover:bg-slate-700 transition-colors">
              Open on Kalshi instead ↗
            </a>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-6 pt-0 flex gap-3">
        <button onClick={onClose}
          className="flex-1 py-2.5 rounded-xl border border-slate-600 text-slate-300 text-sm font-medium hover:bg-slate-700 transition-colors">
          Cancel
        </button>
        <button onClick={handlePlace} disabled={status === "placing" || obLoading || !validPrice}
          className="flex-1 py-2.5 rounded-xl bg-sky-500 hover:bg-sky-400 disabled:bg-slate-600 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors">
          {status === "placing" ? "Placing…" : obLoading ? "Loading…" : `Buy ${Math.floor(shares) || "?"} @ ${validPrice ? parsedCents : "?"}¢`}
        </button>
      </div>
    </ModalShell>
  );
}

function ModalShell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}>
      <div className="bg-slate-800 border border-slate-700 rounded-2xl w-full max-w-md shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
