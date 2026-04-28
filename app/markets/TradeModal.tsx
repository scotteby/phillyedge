"use client";

import { useState } from "react";
import type { MarketWithEdge } from "@/lib/types";
import SignalBadge from "@/components/SignalBadge";

interface Props {
  market: MarketWithEdge;
  onClose: () => void;
  onConfirm: () => void;
}

export default function TradeModal({ market, onClose, onConfirm }: Props) {
  const [side, setSide] = useState<"YES" | "NO">("YES");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usdc = parseFloat(amount) || 0;
  const price = side === "YES" ? market.yes_price : 1 - market.yes_price;
  const shares = price > 0 ? usdc / price : 0;
  const maxProfit = shares - usdc;
  // Kalshi URL: /markets/{series_lower}/{market_ticker_lower}
  // e.g. /markets/kxhighphil/kxhighphil-26apr28
  const seriesLower = market.market_id.split("-")[0].toLowerCase();
  const tickerLower = market.market_id.toLowerCase();
  const kalshiUrl = `https://kalshi.com/markets/${seriesLower}/${tickerLower}`;

  async function handleConfirm() {
    if (!usdc || usdc <= 0) {
      setError("Enter a valid USDC amount.");
      return;
    }
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/trades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          market_id: market.market_id,
          market_question: market.question,
          target_date: market.end_date,
          side,
          amount_usdc: usdc,
          market_pct: market.market_pct,
          my_pct: market.my_pct,
          edge: market.edge,
          signal: market.signal,
          outcome: "pending",
          pnl: null,
          polymarket_url: kalshiUrl,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to log trade");

      window.open(kalshiUrl, "_blank", "noopener");
      onConfirm();
    } catch (err) {
      setError(String(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-2xl w-full max-w-md shadow-2xl">
        {/* Header */}
        <div className="p-6 border-b border-slate-700">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-white font-semibold text-base leading-snug">{market.question}</h2>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-white transition-colors shrink-0 mt-0.5"
            >
              ✕
            </button>
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
                <button
                  key={s}
                  onClick={() => setSide(s)}
                  className={`flex-1 py-2 rounded-lg text-sm font-semibold border transition-colors ${
                    side === s
                      ? s === "YES"
                        ? "bg-emerald-500/20 border-emerald-500 text-emerald-400"
                        : "bg-red-500/20 border-red-500 text-red-400"
                      : "bg-slate-700 border-slate-600 text-slate-400 hover:border-slate-500"
                  }`}
                >
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
              <input
                type="number"
                min="0"
                step="1"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="100"
                className="w-full bg-slate-700 border border-slate-600 rounded-lg pl-7 pr-16 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs">USDC</span>
            </div>
          </div>

          {/* Stats */}
          <div className="bg-slate-700/50 rounded-xl p-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-400">Price ({side})</span>
              <span className="text-white">{(price * 100).toFixed(1)}¢</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Shares</span>
              <span className="text-white">{shares > 0 ? shares.toFixed(2) : "—"}</span>
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

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-red-400 text-sm">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-6 pt-0 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl border border-slate-600 text-slate-300 text-sm font-medium hover:bg-slate-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={submitting}
            className="flex-1 py-2.5 rounded-xl bg-sky-500 hover:bg-sky-400 disabled:bg-slate-600 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors"
          >
            {submitting ? "Logging..." : "Confirm & Open Kalshi →"}
          </button>
        </div>
      </div>
    </div>
  );
}
