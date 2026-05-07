"use client";

import { useState, useEffect } from "react";
import { readHedgeCoverage, writeHedgeCoverage } from "@/lib/strategy";

const COVERAGE_OPTIONS: { value: number; label: string; description: string }[] = [
  { value: 0.25, label: "25%", description: "Light hedge — minimal capital tied up in insurance" },
  { value: 0.50, label: "50%", description: "Balanced — hedge covers half the primary loss if it misses" },
  { value: 0.75, label: "75%", description: "Aggressive hedge — strong protection against near misses" },
  { value: 1.00, label: "100%", description: "Full hedge — hedge fully offsets primary loss on a near miss" },
];

export default function SettingsPage() {
  const [hedgeCoverage, setHedgeCoverage] = useState(0.5);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setHedgeCoverage(readHedgeCoverage());
  }, []);

  function handleCoverageChange(value: number) {
    setHedgeCoverage(value);
    writeHedgeCoverage(value);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="text-slate-400 text-sm mt-1">Configure your trading strategy preferences.</p>
      </div>

      {/* Trading Strategy */}
      <section className="bg-slate-800 border border-slate-700 rounded-xl p-6 space-y-5">
        <div>
          <h2 className="text-lg font-semibold text-white">Trading Strategy</h2>
          <p className="text-slate-400 text-sm mt-0.5">
            We trade exactly two brackets per market: a <span className="text-emerald-400 font-medium">primary</span> trade
            on our forecast bracket and a <span className="text-amber-400 font-medium">hedge</span> trade on the adjacent
            bracket closest to our forecast temperature. We never trade NO positions.
          </p>
        </div>

        {/* Hedge coverage */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-slate-300">Hedge Coverage</label>
            {saved && (
              <span className="text-xs text-emerald-400 font-medium">✓ Saved</span>
            )}
          </div>
          <p className="text-xs text-slate-500">
            How much of the primary trade's cost should the hedge recover if the temperature
            misses into the hedge bracket? Higher coverage = larger hedge position.
          </p>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {COVERAGE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => handleCoverageChange(opt.value)}
                className={`px-4 py-3 rounded-xl border text-sm font-semibold transition-colors text-center ${
                  hedgeCoverage === opt.value
                    ? "bg-amber-500/20 border-amber-500 text-amber-400"
                    : "bg-slate-700/40 border-slate-600 text-slate-400 hover:border-slate-500 hover:text-slate-200"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Description for selected option */}
          <div className="bg-slate-700/30 rounded-lg px-4 py-2.5">
            <p className="text-sm text-slate-300">
              {COVERAGE_OPTIONS.find((o) => o.value === hedgeCoverage)?.description ?? ""}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Formula: <span className="font-mono text-slate-400">
                hedge_contracts = ⌈primary_loss × {Math.round(hedgeCoverage * 100)}% ÷ (1 − hedge_price)⌉
              </span>
            </p>
          </div>
        </div>

        {/* Example */}
        <div className="border border-slate-700/50 rounded-lg px-4 py-3 space-y-1.5 text-sm">
          <p className="text-slate-400 font-medium text-xs uppercase tracking-wide">Example</p>
          <p className="text-slate-300">
            Primary: $20 → 50 contracts @ 40¢ each
          </p>
          <p className="text-slate-400 text-xs">Primary loss if wrong: $20.00</p>
          <p className="text-slate-300 mt-1">
            Hedge @ 30¢ with {Math.round(hedgeCoverage * 100)}% coverage:
            {" "}
            <span className="text-amber-400 font-semibold">
              {Math.ceil((20 * hedgeCoverage) / 0.70)} contracts
              {" · "}
              ${(Math.ceil((20 * hedgeCoverage) / 0.70) * 0.30).toFixed(2)}
            </span>
          </p>
          <p className="text-slate-500 text-xs">
            If hedge wins: +${(Math.ceil((20 * hedgeCoverage) / 0.70) * 0.70).toFixed(2)} payout
            {" → "}covers {Math.round(Math.ceil((20 * hedgeCoverage) / 0.70) * 0.70 / 20 * 100)}% of primary loss
          </p>
        </div>
      </section>

      {/* Storage note */}
      <p className="text-xs text-slate-600 text-center">
        Settings are stored in your browser's local storage and persist across sessions.
      </p>
    </div>
  );
}
