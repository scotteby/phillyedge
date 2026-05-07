"use client";

import { useState, useEffect } from "react";
import type { BracketGroup, BracketMarket } from "@/lib/brackets";
import type { MarketTimeStatus } from "@/lib/nws";
import { buildStrategyLegs, calcHedgeSize, readHedgeCoverage, DEFAULT_HEDGE_COVERAGE } from "@/lib/strategy";
import KalshiBalance from "@/components/KalshiBalance";

// ── Types ─────────────────────────────────────────────────────────────────────

interface PositionLeg {
  id:        string;
  bracket:   BracketMarket;
  side:      "YES";          // always YES — we never trade NO
  pct:       number;         // % of total budget (0–100, sums to 100)
  isPrimary: boolean;        // true = primary (forecast) bracket
}

type LegExecStatus = "placing" | "success" | "error";

interface LegResult {
  id:       string;
  status:   LegExecStatus;
  order_id: string | null;
  demo?:    boolean;
  error?:   string;
}

// ── Allocation helper ─────────────────────────────────────────────────────────

/**
 * Build the default legs using the primary / hedge strategy.
 * Primary = forecast bracket (bracketRole === "primary").
 * Hedge   = secondary bracket (bracketRole === "hedge").
 *
 * Budget allocation: primary gets the user's full budget; hedge size is derived
 * from calcHedgeSize.  Pcts are computed from primary/(primary+hedge) split.
 */
function buildDefaultLegs(
  brackets:      BracketMarket[],
  coverageRatio: number,
  budget:        number = 20,
): PositionLeg[] {
  const stratLegs = buildStrategyLegs(brackets, coverageRatio, budget);
  return stratLegs.map((l) => ({
    id:        `${l.market_id}-YES`,
    bracket:   l.bracket,
    side:      "YES" as const,
    pct:       l.pct,
    isPrimary: l.isPrimary,
  }));
}

function legAmount(pct: number, budget: number): number {
  return (pct / 100) * budget;
}

/** Renormalize an array of legs so their pct values sum to exactly 100. */
function normalizePcts(legs: PositionLeg[]): PositionLeg[] {
  if (legs.length === 0) return legs;
  const total = legs.reduce((s, l) => s + l.pct, 0);
  if (total <= 0) return legs;
  const rawPcts  = legs.map((l) => (l.pct / total) * 100);
  const floored  = rawPcts.map(Math.floor);
  const remainder = 100 - floored.reduce((s, v) => s + v, 0);
  const fracOrder = rawPcts
    .map((v, i) => ({ i, frac: v - floored[i] }))
    .sort((a, b) => b.frac - a.frac);
  for (let j = 0; j < remainder; j++) floored[fracOrder[j].i]++;
  return legs.map((l, i) => ({ ...l, pct: floored[i] }));
}

// ── Kalshi URL helper ─────────────────────────────────────────────────────────

const SERIES_SLUGS: Record<string, string> = {
  kxhighphil:   "highest-temperature-in-philadelphia",
  kxlowtphil:   "lowest-temperature-in-philadelphia",
  kxprecipphil: "precipitation-in-philadelphia",
};

function kalshiUrl(marketId: string) {
  const s = marketId.split("-")[0].toLowerCase();
  return `https://kalshi.com/markets/${s}/${SERIES_SLUGS[s] ?? s}/${marketId.toLowerCase()}`;
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  group:       BracketGroup;
  timeStatus?: MarketTimeStatus;
  onClose:     () => void;
}

export default function PositionBuilderModal({ group, timeStatus = "active", onClose }: Props) {
  const isLate = timeStatus === "warning" || timeStatus === "locked";

  const [budget,        setBudget]        = useState("20");
  const [coverageRatio, setCoverageRatio] = useState(DEFAULT_HEDGE_COVERAGE);
  const [legs,          setLegs]          = useState<PositionLeg[]>(() =>
    buildDefaultLegs(group.brackets, DEFAULT_HEDGE_COVERAGE, 20)
  );
  const [legResults,    setLegResults]    = useState<LegResult[]>([]);
  const [phase,         setPhase]         = useState<"build" | "placing" | "done">("build");
  const [error,         setError]         = useState<string | null>(null);
  const [showAddPicker, setShowAddPicker] = useState(false);

  // Read hedge coverage from localStorage after mount
  useEffect(() => {
    const stored = readHedgeCoverage();
    if (stored !== DEFAULT_HEDGE_COVERAGE) {
      setCoverageRatio(stored);
      setLegs(buildDefaultLegs(group.brackets, stored, 20));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rebuild legs when coverage ratio changes
  function handleCoverageChange(ratio: number) {
    setCoverageRatio(ratio);
    setLegs(buildDefaultLegs(group.brackets, ratio, parseFloat(budget) || 20));
  }

  const totalBudget = parseFloat(budget) || 0;

  // ── Derived stats ─────────────────────────────────────────────────────────

  const totalDeployed = legs.reduce((s, l) => s + legAmount(l.pct, totalBudget), 0);

  const totalEV = legs.reduce((s, l) => {
    const amt  = legAmount(l.pct, totalBudget);
    return s + amt * (l.bracket.edge / 100);
  }, 0);

  const bestCase = legs.reduce((s, l) => {
    const amt   = legAmount(l.pct, totalBudget);
    const price = l.bracket.yes_price;
    return s + (price > 0 ? amt * (1 - price) / price : 0);
  }, 0);

  // ── Leg mutations ─────────────────────────────────────────────────────────

  function updateLegAmount(id: string, raw: string) {
    const newAmt = parseFloat(raw);
    if (isNaN(newAmt) || totalBudget <= 0) return;
    const newPct = Math.min(200, Math.max(0, (newAmt / totalBudget) * 100));
    setLegs((prev) => prev.map((l) => l.id === id ? { ...l, pct: newPct } : l));
  }

  function removeLeg(id: string) {
    setLegs((prev) => normalizePcts(prev.filter((l) => l.id !== id)));
  }

  function addCustomLeg(bracket: BracketMarket) {
    const id = `${bracket.market_id}-YES-custom`;
    setLegs((prev) => {
      if (prev.some((l) => l.bracket.market_id === bracket.market_id)) return prev;
      // Give the new leg a proportional share (equal weight to the others) then renormalize
      const equalShare = prev.length > 0 ? prev[0].pct : 100;
      return normalizePcts([...prev, { id, bracket, side: "YES", pct: equalShare, isPrimary: false }]);
    });
    setShowAddPicker(false);
  }

  // ── Trade execution ───────────────────────────────────────────────────────

  async function handlePlaceAll() {
    if (totalBudget <= 0) { setError("Enter a budget greater than $0."); return; }
    if (legs.length === 0) { setError("Add at least one trade."); return; }
    setError(null);
    setPhase("placing");
    setLegResults(legs.map((l) => ({ id: l.id, status: "placing", order_id: null })));

    await Promise.all(
      legs.map(async (leg) => {
        const amt   = parseFloat(legAmount(leg.pct, totalBudget).toFixed(2));
        const price = leg.bracket.yes_price; // always YES side

        try {
          const res  = await fetch("/api/place-trade", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ticker:          leg.bracket.market_id,
              side:            "YES",
              amount_dollars:  amt,
              limit_price:     price,
              market_question: `${group.title} — ${leg.bracket.range.label}`,
              target_date:     leg.bracket.end_date,
              market_pct:      leg.bracket.yes_pct,
              my_pct:          leg.bracket.confidence,
              edge:            leg.bracket.edge,
              signal:          leg.bracket.bracketRole === "primary" ? "strong-buy" : "buy",
            }),
          });
          const json = await res.json();
          setLegResults((prev) => prev.map((r) =>
            r.id === leg.id
              ? res.ok
                ? { id: leg.id, status: "success", order_id: json.order_id ?? null, demo: !!json.demo }
                : { id: leg.id, status: "error",   order_id: null, error: json.error ?? "Order failed" }
              : r
          ));
        } catch (err) {
          setLegResults((prev) => prev.map((r) =>
            r.id === leg.id
              ? { id: leg.id, status: "error", order_id: null, error: String(err) }
              : r
          ));
        }
      })
    );

    setPhase("done");
  }

  // ── Done screen ───────────────────────────────────────────────────────────

  if (phase === "done") {
    const okCount   = legResults.filter((r) => r.status === "success").length;
    const failCount = legResults.filter((r) => r.status === "error").length;
    const allOk     = failCount === 0;
    const isDemo    = legResults.some((r) => r.demo);

    return (
      <ModalShell onClose={onClose}>
        <div className="p-6 space-y-4">
          {isDemo && <DemoBanner />}

          <div className="text-center space-y-1.5">
            <p className="text-4xl">
              {allOk ? "✅" : failCount === legResults.length ? "❌" : "⚠️"}
            </p>
            <p className="text-white font-bold text-lg">
              {allOk
                ? `${okCount} Trade${okCount !== 1 ? "s" : ""} Placed!`
                : failCount === legResults.length
                ? "Orders Failed"
                : `${okCount} of ${legResults.length} Trades Placed`}
            </p>
            <p className="text-slate-400 text-sm">
              ${totalDeployed.toFixed(2)} deployed · {legs.length} leg{legs.length !== 1 ? "s" : ""}
            </p>
          </div>

          <div className="space-y-2 max-h-64 overflow-y-auto">
            {legResults.map((r) => {
              const leg = legs.find((l) => l.id === r.id);
              if (!leg) return null;
              return (
                <div key={r.id} className={`flex items-start justify-between gap-3 px-3 py-2 rounded-lg text-sm border ${
                  r.status === "success"
                    ? "bg-emerald-500/10 border-emerald-500/20"
                    : "bg-red-500/10 border-red-500/20"
                }`}>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={r.status === "success" ? "text-emerald-400" : "text-red-400"}>
                        {r.status === "success" ? "✓" : "✗"}
                      </span>
                      <span className="text-white font-medium">{leg.bracket.range.label}</span>
                      <SideBadge side={leg.side} />
                      <span className="text-slate-400 text-xs">
                        ${legAmount(leg.pct, totalBudget).toFixed(2)}
                      </span>
                    </div>
                    {r.status === "error" && r.error && (
                      <p className="text-red-400 text-xs mt-0.5 line-clamp-2 pl-4">{r.error}</p>
                    )}
                    {r.status === "success" && r.order_id && (
                      <p className="text-slate-500 text-xs font-mono mt-0.5 pl-4 truncate">{r.order_id}</p>
                    )}
                  </div>
                  {r.status === "error" && (
                    <a href={kalshiUrl(leg.bracket.market_id)} target="_blank" rel="noopener noreferrer"
                      className="text-sky-400 text-xs hover:text-sky-300 shrink-0">
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

  // ── Build / Placing screen ────────────────────────────────────────────────

  const isPlacing = phase === "placing";

  return (
    <ModalShell onClose={onClose}>
      <div className="flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-700 shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wide font-semibold mb-0.5">
                Position Builder
              </p>
              <h2 className="text-white font-semibold text-base leading-snug">{group.title}</h2>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <KalshiBalance />
              {!isPlacing && (
                <button onClick={onClose}
                  className="text-slate-400 hover:text-white transition-colors text-lg leading-none">
                  ✕
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-4 space-y-4">

          {/* Late trading warning */}
          {isLate && (
            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-4 py-2.5">
              <p className="text-sm text-yellow-300 font-semibold">
                ⚠️ Late trading — consider reducing position sizes
              </p>
              <p className="text-xs text-yellow-400/70 mt-0.5">
                {timeStatus === "locked"
                  ? "This market is near resolution. Signals may not reflect current conditions."
                  : "Today's weather is near its peak. Default budget reduced to $20."}
              </p>
            </div>
          )}

          {/* Budget + coverage inputs */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-slate-300 whitespace-nowrap">
                Total budget:
              </label>
              <div className="relative w-36">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
                <input
                  type="number" min="1" value={budget}
                  onChange={(e) => {
                    setBudget(e.target.value);
                    const b = parseFloat(e.target.value) || 20;
                    setLegs(buildDefaultLegs(group.brackets, coverageRatio, b));
                  }}
                  disabled={isPlacing}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg pl-7 pr-14 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 disabled:opacity-50"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs">USDC</span>
              </div>
            </div>

            {/* Hedge coverage selector */}
            {!isPlacing && (
              <div className="flex items-center gap-2">
                <label className="text-xs text-slate-400 whitespace-nowrap">Hedge:</label>
                <div className="flex gap-1">
                  {([0.25, 0.5, 0.75, 1.0] as const).map((v) => (
                    <button
                      key={v}
                      onClick={() => handleCoverageChange(v)}
                      className={`text-xs px-2 py-1 rounded border transition-colors ${
                        coverageRatio === v
                          ? "bg-amber-500/20 border-amber-500 text-amber-400"
                          : "border-slate-600 text-slate-400 hover:border-slate-500 hover:text-slate-300"
                      }`}
                    >
                      {Math.round(v * 100)}%
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Legs list */}
          {legs.length > 0 ? (
            <div className="space-y-2">
              {/* Column headers — desktop */}
              <div className="hidden sm:grid grid-cols-[1fr_96px_52px_28px] gap-2 px-1 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                <div>Bracket</div>
                <div className="text-right">Amount</div>
                <div className="text-right">Edge</div>
                <div />
              </div>

              {legs.map((leg) => {
                const amt     = legAmount(leg.pct, totalBudget);
                const edgeVal = leg.bracket.edge;
                const edgeCls = edgeVal >= 25 ? "text-emerald-400" : edgeVal >= 10 ? "text-sky-400" : edgeVal >= 0 ? "text-slate-300" : "text-orange-400";
                const execRes  = legResults.find((r) => r.id === leg.id);

                return (
                  <div key={leg.id}
                    className={`rounded-xl border px-3 py-2.5 transition-colors ${
                      isPlacing
                        ? "bg-slate-700/30 border-slate-600/50"
                        : "bg-slate-700/40 border-slate-600"
                    }`}
                  >
                    {/* ── Desktop row ─────────────────────────────────── */}
                    <div className="hidden sm:grid grid-cols-[1fr_96px_52px_28px] gap-2 items-center">
                      {/* Label + role badge */}
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-sm font-medium text-white truncate">
                          {leg.bracket.range.label}
                        </span>
                        {leg.isPrimary ? (
                          <span className="shrink-0 text-[10px] bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-1 py-0.5 rounded font-semibold">
                            PRIMARY
                          </span>
                        ) : (
                          <span className="shrink-0 text-[10px] bg-amber-500/20 text-amber-400 border border-amber-500/30 px-1 py-0.5 rounded font-semibold">
                            HEDGE
                          </span>
                        )}
                      </div>
                      {/* Amount */}
                      <div className="flex justify-end">
                        {isPlacing ? (
                          <div className="flex items-center gap-1.5">
                            <span className="text-white text-sm">${amt.toFixed(2)}</span>
                            {execRes && <LegStatusIcon status={execRes.status} />}
                          </div>
                        ) : (
                          <div className="relative w-24">
                            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs">$</span>
                            <input
                              type="number" min="0" step="1"
                              value={amt.toFixed(2)}
                              onChange={(e) => updateLegAmount(leg.id, e.target.value)}
                              className="w-full bg-slate-600/60 border border-slate-500 rounded-lg pl-5 pr-2 py-1 text-white text-sm text-right focus:outline-none focus:ring-1 focus:ring-sky-500"
                            />
                          </div>
                        )}
                      </div>
                      {/* Edge */}
                      <div className={`text-right text-sm font-semibold ${edgeCls}`}>
                        {edgeVal > 0 ? "+" : ""}{edgeVal}
                      </div>
                      {/* Remove */}
                      <div className="flex justify-center">
                        {!isPlacing && (
                          <button onClick={() => removeLeg(leg.id)}
                            className="text-slate-500 hover:text-red-400 transition-colors w-6 h-6 flex items-center justify-center rounded text-base">
                            ×
                          </button>
                        )}
                      </div>
                    </div>

                    {/* ── Mobile row ──────────────────────────────────── */}
                    <div className="sm:hidden space-y-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-white flex-1 min-w-0 truncate">
                          {leg.bracket.range.label}
                        </span>
                        {leg.isPrimary ? (
                          <span className="text-[10px] bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-1 py-0.5 rounded font-semibold shrink-0">
                            PRIMARY
                          </span>
                        ) : (
                          <span className="text-[10px] bg-amber-500/20 text-amber-400 border border-amber-500/30 px-1 py-0.5 rounded font-semibold shrink-0">
                            HEDGE
                          </span>
                        )}
                        <span className={`text-sm font-semibold shrink-0 ${edgeCls}`}>
                          {edgeVal > 0 ? "+" : ""}{edgeVal}
                        </span>
                        {!isPlacing && (
                          <button onClick={() => removeLeg(leg.id)}
                            className="text-slate-500 hover:text-red-400 transition-colors w-6 h-6 flex items-center justify-center shrink-0">
                            ×
                          </button>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {isPlacing ? (
                          <div className="flex items-center gap-2">
                            <span className="text-white text-sm font-medium">${amt.toFixed(2)}</span>
                            {execRes && <LegStatusIcon status={execRes.status} />}
                          </div>
                        ) : (
                          <div className="relative w-28">
                            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs">$</span>
                            <input
                              type="number" min="0" step="1"
                              value={amt.toFixed(2)}
                              onChange={(e) => updateLegAmount(leg.id, e.target.value)}
                              className="w-full bg-slate-600/60 border border-slate-500 rounded-lg pl-5 pr-2 py-1 text-white text-sm focus:outline-none focus:ring-1 focus:ring-sky-500"
                            />
                          </div>
                        )}
                        <span className="text-xs text-slate-500 ml-auto">
                          {(leg.bracket.yes_price * 100).toFixed(0)}¢/share
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-8 text-slate-500">
              <p className="font-medium">No forecast bracket available</p>
              <p className="text-xs mt-1">Enter a forecast to see suggested trades.</p>
            </div>
          )}

          {/* Add custom trade */}
          {!isPlacing && legs.length > 0 && (
            showAddPicker ? (
              <AddTradePicker
                brackets={group.brackets}
                existingLegs={legs}
                onAdd={addCustomLeg}
                onCancel={() => setShowAddPicker(false)}
              />
            ) : (
              <button
                onClick={() => setShowAddPicker(true)}
                className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-white transition-colors"
              >
                <span className="text-base leading-none font-bold">+</span>
                Add custom trade
              </button>
            )
          )}

          {/* Progress indicator while placing */}
          {isPlacing && (
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <span>Placing {legs.length} trade{legs.length !== 1 ? "s" : ""}…</span>
              <span className="flex gap-1">
                {legResults.map((r) => (
                  <LegStatusIcon key={r.id} status={r.status} />
                ))}
              </span>
            </div>
          )}

          {/* Summary */}
          <div className="bg-slate-700/40 border border-slate-600 rounded-xl p-4 space-y-2 text-sm">
            <SummaryRow label="Total deployed" value={`$${totalDeployed.toFixed(2)}`} />
            <SummaryRow
              label="Combined EV"
              value={`${totalEV >= 0 ? "+" : ""}$${totalEV.toFixed(2)}`}
              valueClass={totalEV >= 0 ? "text-emerald-400 font-semibold" : "text-red-400 font-semibold"}
            />
            <div className="border-t border-slate-600/60 pt-2 space-y-1.5">
              <SummaryRow label="🏆 Best case" value={`+$${bestCase.toFixed(2)}`} valueClass="text-emerald-400" />
              <SummaryRow label="Legs" value={String(legs.length)} />
            </div>
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-red-400 text-sm">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-700 shrink-0 flex gap-3">
          <button onClick={onClose} disabled={isPlacing}
            className="flex-1 py-2.5 rounded-xl border border-slate-600 text-slate-300 text-sm font-medium hover:bg-slate-700 transition-colors disabled:opacity-40 disabled:pointer-events-none">
            Cancel
          </button>
          <button onClick={handlePlaceAll} disabled={isPlacing || legs.length === 0}
            className="flex-1 py-2.5 rounded-xl bg-sky-500 hover:bg-sky-400 disabled:bg-slate-600 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors">
            {isPlacing
              ? `Placing ${legs.length} trade${legs.length !== 1 ? "s" : ""}…`
              : `Place ${legs.length} Trade${legs.length !== 1 ? "s" : ""} →`}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// ── AddTradePicker ────────────────────────────────────────────────────────────

function AddTradePicker({
  brackets,
  existingLegs,
  onAdd,
  onCancel,
}: {
  brackets:     BracketMarket[];
  existingLegs: PositionLeg[];
  onAdd:        (b: BracketMarket) => void;
  onCancel:     () => void;
}) {
  const existingIds = new Set(existingLegs.map((l) => l.bracket.market_id));

  // Only show brackets not already in legs (always YES side)
  const options = brackets.filter((b) => !existingIds.has(b.market_id));

  return (
    <div className="bg-slate-700/40 border border-slate-600 rounded-xl p-3 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
          Add custom trade
        </p>
        <button onClick={onCancel}
          className="text-slate-500 hover:text-white transition-colors text-sm leading-none">
          ✕
        </button>
      </div>
      {options.length === 0 ? (
        <p className="text-slate-500 text-sm py-2 text-center">All brackets already added.</p>
      ) : (
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {options.map((b) => {
            const edgeCls = b.edge >= 10 ? "text-emerald-400" : b.edge <= -10 ? "text-orange-400" : "text-slate-500";
            return (
              <button
                key={b.market_id}
                onClick={() => onAdd(b)}
                className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm hover:bg-slate-600/50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <span className="text-white font-medium">{b.range.label}</span>
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-emerald-500/20 text-emerald-400 border-emerald-500/30">YES</span>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <span className={`font-semibold ${edgeCls}`}>
                    {b.edge > 0 ? "+" : ""}{b.edge}pt
                  </span>
                  <span className="text-slate-400">{(b.yes_price * 100).toFixed(0)}¢</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Small shared components ───────────────────────────────────────────────────

function SideBadge({ side }: { side: "YES" | "NO" }) {
  return (
    <span className={`text-xs font-bold px-2 py-0.5 rounded border shrink-0 ${
      side === "YES"
        ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
        : "bg-orange-500/20 text-orange-400 border-orange-500/30"
    }`}>
      {side}
    </span>
  );
}

function LegStatusIcon({ status }: { status: LegExecStatus }) {
  if (status === "success") return <span className="text-emerald-400 text-sm">✓</span>;
  if (status === "error")   return <span className="text-red-400 text-sm">✗</span>;
  // placing — spinning indicator
  return (
    <span className="inline-block animate-spin text-slate-400 text-sm">
      ⟳
    </span>
  );
}

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

function SummaryRow({
  label, value, valueClass = "text-white",
}: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-slate-400">{label}</span>
      <span className={valueClass}>{value}</span>
    </div>
  );
}

function DemoBanner() {
  return (
    <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 text-amber-400 text-sm font-semibold text-center">
      ⚠️ DEMO MODE — no real money spent
    </div>
  );
}
