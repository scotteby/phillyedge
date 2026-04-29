"use client";

import { useState, useMemo } from "react";
import type { BracketGroup, BracketMarket } from "@/lib/brackets";
import SignalBadge from "@/components/SignalBadge";

// ── Types ─────────────────────────────────────────────────────────────────────

type LegReason = "primary" | "adjacent-hedge" | "no-far";

interface PositionLeg {
  id: string;           // bracket.market_id + side
  bracket: BracketMarket;
  side: "YES" | "NO";
  reason: LegReason;
  label: string;
  confidence: number;   // 0–100, our estimate this leg wins
  price: number;        // 0–1, cost per share on chosen side
  pct: number;          // % of total budget (slider value)
  enabled: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function legAmount(leg: PositionLeg, budget: number) {
  return (leg.pct / 100) * budget;
}

function profitIfWin(amount: number, price: number) {
  return price > 0 ? amount * (1 - price) / price : 0;
}

function legEV(leg: PositionLeg, budget: number) {
  const a   = legAmount(leg, budget);
  const p   = leg.confidence / 100;
  const win = profitIfWin(a, leg.price);
  return p * win - (1 - p) * a;
}

function reasonLabel(r: LegReason) {
  if (r === "primary")         return { text: "Primary",  cls: "bg-sky-500/20 text-sky-400 border-sky-500/30" };
  if (r === "adjacent-hedge")  return { text: "Hedge",    cls: "bg-amber-500/20 text-amber-400 border-amber-500/30" };
  return                              { text: "NO cover",  cls: "bg-purple-500/20 text-purple-400 border-purple-500/30" };
}

const SERIES_SLUGS: Record<string, string> = {
  kxhighphil:   "highest-temperature-in-philadelphia",
  kxlowtphil:   "lowest-temperature-in-philadelphia",
  kxprecipphil: "precipitation-in-philadelphia",
};

function kalshiUrl(marketId: string) {
  const s = marketId.split("-")[0].toLowerCase();
  return `https://kalshi.com/markets/${s}/${SERIES_SLUGS[s] ?? s}/${marketId.toLowerCase()}`;
}

// ── Build initial legs from a target bracket ──────────────────────────────────

function buildLegs(brackets: BracketMarket[], targetIdx: number): PositionLeg[] {
  const legs: PositionLeg[] = [];
  const target = brackets[targetIdx];

  // 1. Primary YES on target bracket
  legs.push({
    id:         `${target.market_id}-YES`,
    bracket:    target,
    side:       "YES",
    reason:     "primary",
    label:      `YES ${target.range.label}`,
    confidence: target.confidence || 50,
    price:      target.yes_price,
    pct:        50,
    enabled:    true,
  });

  // 2. Adjacent YES hedges (idx ±1)
  for (const offset of [-1, 1]) {
    const i = targetIdx + offset;
    if (i < 0 || i >= brackets.length) continue;
    const b = brackets[i];
    legs.push({
      id:         `${b.market_id}-YES-hedge`,
      bracket:    b,
      side:       "YES",
      reason:     "adjacent-hedge",
      label:      `YES ${b.range.label} (hedge)`,
      confidence: 30,
      price:      b.yes_price,
      pct:        10,
      enabled:    false, // off by default — user opts in
    });
  }

  // 3. NO bets on brackets 2+ away
  // Distribute the remaining 50% of budget across far legs so defaults sum to 100%.
  // Use integer arithmetic: base allocation + 1 extra point to first N legs to absorb remainder.
  const farBrackets = brackets.filter((_, i) => Math.abs(i - targetIdx) >= 2);
  const farTotal    = 50; // primary takes 50%, far legs share the other 50%
  const baseEach    = farBrackets.length > 0 ? Math.floor(farTotal / farBrackets.length) : 0;
  const extraCount  = farBrackets.length > 0 ? farTotal - baseEach * farBrackets.length : 0;

  for (let fi = 0; fi < farBrackets.length; fi++) {
    const b          = farBrackets[fi];
    const noPrice    = 1 - b.yes_price;
    const confidence = Math.round((1 - b.yes_price) * 100);
    legs.push({
      id:         `${b.market_id}-NO`,
      bracket:    b,
      side:       "NO",
      reason:     "no-far",
      label:      `NO ${b.range.label}`,
      confidence,
      price:      noPrice,
      pct:        baseEach + (fi < extraCount ? 1 : 0),
      enabled:    true,
    });
  }

  return legs;
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  group: BracketGroup;
  onClose: () => void;
}

export default function PositionBuilderModal({ group, onClose }: Props) {
  const defaultTarget = group.brackets.findIndex((b) => b.relation === "forecast");
  const [targetIdx, setTargetIdx] = useState(defaultTarget >= 0 ? defaultTarget : 0);
  const [budget, setBudget]       = useState("100");
  const [legs, setLegs]           = useState<PositionLeg[]>(() =>
    buildLegs(group.brackets, defaultTarget >= 0 ? defaultTarget : 0)
  );
  const [submitting,   setSubmitting]   = useState(false);
  const [submitted,    setSubmitted]    = useState(false);
  const [error,        setError]        = useState<string | null>(null);
  const [legResults,   setLegResults]   = useState<
    Array<{ id: string; order_id: string | null; ok: boolean; demo?: boolean; error?: string }>
  >([]);

  const totalBudget   = parseFloat(budget) || 0;
  const enabledLegs   = legs.filter((l) => l.enabled);
  const totalDeployed = enabledLegs.reduce((s, l) => s + legAmount(l, totalBudget), 0);
  const totalEV       = enabledLegs.reduce((s, l) => s + legEV(l, totalBudget), 0);

  const bestCase = enabledLegs.reduce(
    (s, l) => s + profitIfWin(legAmount(l, totalBudget), l.price), 0
  );
  const worstCase = -enabledLegs.reduce((s, l) => s + legAmount(l, totalBudget), 0);

  function selectTarget(idx: number) {
    setTargetIdx(idx);
    setLegs(buildLegs(group.brackets, idx));
  }

  function setLegPct(id: string, pct: number) {
    setLegs((prev) => prev.map((l) => (l.id === id ? { ...l, pct } : l)));
  }

  function toggleLeg(id: string) {
    setLegs((prev) => prev.map((l) => (l.id === id ? { ...l, enabled: !l.enabled } : l)));
  }

  async function handleConfirm() {
    if (totalBudget <= 0) { setError("Enter a budget greater than $0."); return; }
    if (enabledLegs.length === 0) { setError("Enable at least one leg."); return; }

    setSubmitting(true);
    setError(null);

    const results = await Promise.all(
      enabledLegs.map(async (leg) => {
        const legAmt   = parseFloat(legAmount(leg, totalBudget).toFixed(2));
        const legPrice = leg.price;

        try {
          const res  = await fetch("/api/place-trade", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ticker:          leg.bracket.market_id,
              side:            leg.side,
              amount_dollars:  legAmt,
              limit_price:     legPrice,
              market_question: `${group.title} — ${leg.bracket.range.label}`,
              target_date:     leg.bracket.end_date,
              market_pct:      leg.bracket.yes_pct,
              my_pct:          leg.confidence,
              edge:            leg.confidence - leg.bracket.yes_pct,
              signal:          leg.bracket.signal,
            }),
          });
          const json = await res.json();
          if (!res.ok) return { id: leg.id, ok: false as const, order_id: null, error: json.error ?? "Failed" };
          return { id: leg.id, ok: true as const, order_id: json.order_id ?? null, demo: !!json.demo };
        } catch (err) {
          return { id: leg.id, ok: false as const, order_id: null, error: String(err) };
        }
      })
    );

    setLegResults(results);
    setSubmitting(false);
    setSubmitted(true);
  }

  if (submitted) {
    const okCount   = legResults.filter((r) => r.ok).length;
    const failCount = legResults.filter((r) => !r.ok).length;
    const allOk     = failCount === 0;
    const isDemo    = legResults.some((r) => r.demo);

    return (
      <ModalShell onClose={onClose}>
        <div className="p-6 space-y-4">
          {isDemo && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 text-amber-400 text-sm font-semibold text-center">
              ⚠️ DEMO MODE — no real money spent
            </div>
          )}

          <div className="text-center space-y-2">
            <p className="text-4xl">{allOk ? "✅" : failCount === legResults.length ? "❌" : "⚠️"}</p>
            <p className="text-white font-bold text-lg">
              {allOk
                ? "All Orders Placed!"
                : failCount === legResults.length
                ? "Orders Failed"
                : `${okCount} of ${legResults.length} Orders Placed`}
            </p>
            <p className="text-slate-400 text-sm">
              ${totalDeployed.toFixed(2)} · {enabledLegs.length} leg{enabledLegs.length !== 1 ? "s" : ""}
            </p>
          </div>

          {/* Per-leg results */}
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {legResults.map((r) => {
              const leg = enabledLegs.find((l) => l.id === r.id);
              if (!leg) return null;
              return (
                <div key={r.id}
                  className={`rounded-lg px-3 py-2 text-sm flex items-start justify-between gap-2 ${
                    r.ok
                      ? "bg-emerald-500/10 border border-emerald-500/20"
                      : "bg-red-500/10 border border-red-500/20"
                  }`}>
                  <div className="min-w-0">
                    <span className={r.ok ? "text-emerald-400" : "text-red-400"}>
                      {r.ok ? "✓" : "✗"}
                    </span>
                    <span className="text-white ml-2">{leg.label}</span>
                    {!r.ok && r.error && (
                      <p className="text-red-400 text-xs mt-0.5 truncate">{r.error}</p>
                    )}
                    {r.ok && r.order_id && (
                      <p className="text-slate-500 text-xs font-mono mt-0.5 truncate">
                        {r.order_id}
                      </p>
                    )}
                  </div>
                  {!r.ok && (
                    <a href={kalshiUrl(leg.bracket.market_id)} target="_blank" rel="noopener noreferrer"
                      className="text-xs text-sky-400 hover:text-sky-300 shrink-0 whitespace-nowrap">
                      Kalshi ↗
                    </a>
                  )}
                </div>
              );
            })}
          </div>

          <button onClick={onClose}
            className="w-full py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-white text-sm font-semibold transition-colors">
            Close
          </button>
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell onClose={onClose}>
      <div className="flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-700 shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wide font-semibold mb-0.5">Position Builder</p>
              <h2 className="text-white font-semibold text-base">{group.title}</h2>
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors mt-0.5">✕</button>
          </div>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-4 space-y-5">

          {/* 1 — Target bracket selector */}
          <section>
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
              1 · Select Target Bracket
            </h3>
            <div className="space-y-1">
              {group.brackets.map((b, i) => (
                <button
                  key={b.market_id}
                  onClick={() => selectTarget(i)}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors border ${
                    targetIdx === i
                      ? "bg-sky-500/15 border-sky-500/50 text-white"
                      : "border-transparent hover:bg-slate-700/50 text-slate-300"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{b.range.label}</span>
                    {b.relation === "forecast" && (
                      <span className="text-xs bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-1.5 py-0.5 rounded font-semibold">
                        YOUR FORECAST
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-slate-400">
                    <span>Kalshi {b.yes_pct}%</span>
                    {targetIdx === i && <span className="text-sky-400">✓ selected</span>}
                  </div>
                </button>
              ))}
            </div>
          </section>

          {/* 2 — Total budget */}
          <section>
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
              2 · Total Budget
            </h3>
            <div className="relative w-48">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
              <input
                type="number" min="1" value={budget}
                onChange={(e) => setBudget(e.target.value)}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg pl-7 pr-14 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs">USDC</span>
            </div>
          </section>

          {/* 3 — Allocation sliders */}
          <section>
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
              3 · Allocate per Leg
            </h3>
            <div className="space-y-3">
              {legs.map((leg) => {
                const { text: rText, cls: rCls } = reasonLabel(leg.reason);
                const amount = legAmount(leg, totalBudget);
                const ev     = legEV(leg, totalBudget);

                return (
                  <div
                    key={leg.id}
                    className={`rounded-xl border p-3 transition-colors ${
                      leg.enabled ? "bg-slate-700/40 border-slate-600" : "bg-slate-800/40 border-slate-700/40 opacity-50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <input
                          type="checkbox" checked={leg.enabled}
                          onChange={() => toggleLeg(leg.id)}
                          className="accent-sky-500 shrink-0"
                        />
                        <span className="text-sm font-medium text-white truncate">{leg.label}</span>
                        <span className={`text-xs px-1.5 py-0.5 rounded border font-semibold shrink-0 ${rCls}`}>{rText}</span>
                      </div>
                      <div className="text-right shrink-0 text-xs text-slate-400">
                        <span className="text-white font-semibold">${amount.toFixed(2)}</span>
                        <span className={`ml-2 ${ev >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          EV {ev >= 0 ? "+" : ""}${ev.toFixed(2)}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <input
                        type="range" min="0" max="100" step="1"
                        value={leg.pct}
                        disabled={!leg.enabled}
                        onChange={(e) => setLegPct(leg.id, parseInt(e.target.value))}
                        className="flex-1 accent-sky-500 disabled:opacity-40"
                      />
                      <span className="text-xs text-slate-400 w-10 text-right">{leg.pct}%</span>
                    </div>

                    <div className="mt-1 flex gap-3 text-xs text-slate-500">
                      <span>Our confidence: {leg.confidence}%</span>
                      <span>Price: {(leg.price * 100).toFixed(0)}¢</span>
                      <span>Max profit: +${profitIfWin(amount, leg.price).toFixed(2)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* 4 — Summary */}
          <section>
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
              4 · Position Summary
            </h3>
            <div className="bg-slate-700/40 border border-slate-600 rounded-xl p-4 space-y-2 text-sm">
              <Row label="Total deployed"   value={`$${totalDeployed.toFixed(2)}`} />
              {totalBudget - totalDeployed > 0.005 && (
                <Row
                  label="Undeployed"
                  value={`$${(totalBudget - totalDeployed).toFixed(2)}`}
                  valueClass="text-slate-500"
                />
              )}
              <Row label="Combined EV"
                value={`${totalEV >= 0 ? "+" : ""}$${totalEV.toFixed(2)}`}
                valueClass={totalEV >= 0 ? "text-emerald-400 font-bold" : "text-red-400 font-bold"}
              />
              <div className="border-t border-slate-600 my-1" />
              <Row label="🏆 Best case"
                value={`+$${bestCase.toFixed(2)}`}
                valueClass="text-emerald-400"
              />
              <Row label="💀 Worst case"
                value={`-$${Math.abs(worstCase).toFixed(2)}`}
                valueClass="text-red-400"
              />
              <Row label="Active legs" value={String(enabledLegs.length)} />
            </div>
          </section>

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-red-400 text-sm">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-700 shrink-0 flex gap-3">
          <button onClick={onClose}
            className="flex-1 py-2.5 rounded-xl border border-slate-600 text-slate-300 text-sm font-medium hover:bg-slate-700 transition-colors">
            Cancel
          </button>
          <button onClick={handleConfirm} disabled={submitting || enabledLegs.length === 0}
            className="flex-1 py-2.5 rounded-xl bg-sky-500 hover:bg-sky-400 disabled:bg-slate-600 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors">
            {submitting
              ? `Placing ${enabledLegs.length} order${enabledLegs.length !== 1 ? "s" : ""}…`
              : `Place ${enabledLegs.length} Trade${enabledLegs.length !== 1 ? "s" : ""}`}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ModalShell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div
        className="bg-slate-800 border border-slate-700 rounded-2xl w-full max-w-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function Row({
  label, value, valueClass = "text-white",
}: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-slate-400">{label}</span>
      <span className={valueClass}>{value}</span>
    </div>
  );
}
