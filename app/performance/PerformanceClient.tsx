"use client";

import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  CALIBRATION_BINS,
  STATED_STD_BY_CONFIDENCE,
  calibrationBin,
  generateInsights,
  stdDev,
  type ForecastResultRow,
  type RecommendationResultRow,
} from "@/lib/settlement";
import type { ForecastConfidence } from "@/lib/types";

// ── DB-shaped types (numerics arrive as strings or numbers) ──────────────────

export interface ForecastResultDB {
  id:               string;
  forecast_id:      string;
  forecast_date:    string;
  metric:           "high" | "low" | "precip";
  predicted_value:  number | string;
  actual_value:     number | string;
  error:            number | string;
  abs_error:        number | string;
  confidence_level: ForecastConfidence;
  created_at:       string;
}

export interface RecommendationResultDB {
  id:                    string;
  trade_id:              string;
  market_id:             string;
  forecast_date:         string;
  signal:                string;
  edge:                  number | string;
  bracket_type:          "forecast" | "adjacent_low" | "adjacent_high" | "other";
  recommended_size:      number | string;
  actually_placed:       boolean;
  actual_size:           number | string | null;
  placed_at:             string | null;
  would_have_won:        boolean;
  hypothetical_pnl:      number | string;
  normalized_pnl_at_10:  number | string;
  actual_pnl:            number | string | null;
  created_at:            string;
}

interface Props {
  forecastResults: ForecastResultDB[];
  recResults:      RecommendationResultDB[];
}

const num = (x: number | string | null | undefined): number =>
  x == null ? 0 : typeof x === "number" ? x : parseFloat(x);

// ── Component ────────────────────────────────────────────────────────────────

export default function PerformanceClient({ forecastResults, recResults }: Props) {
  // Coerce numeric strings up front so all downstream math is straightforward
  const fr = useMemo(
    () =>
      forecastResults.map((r) => ({
        ...r,
        predicted_value: num(r.predicted_value),
        actual_value:    num(r.actual_value),
        error:           num(r.error),
        abs_error:       num(r.abs_error),
      })),
    [forecastResults],
  );

  const rr = useMemo(
    () =>
      recResults.map((r) => ({
        ...r,
        edge:                 num(r.edge),
        recommended_size:     num(r.recommended_size),
        actual_size:          r.actual_size == null ? null : num(r.actual_size),
        hypothetical_pnl:     num(r.hypothetical_pnl),
        normalized_pnl_at_10: num(r.normalized_pnl_at_10),
        actual_pnl:           r.actual_pnl == null ? null : num(r.actual_pnl),
      })),
    [recResults],
  );

  // Insights — settlement.ts expects pure ForecastResultRow / RecommendationResultRow shapes,
  // and only reads predicted_value/actual_value/metric/signal/edge/bracket_type/would_have_won
  // /normalized_pnl_at_10. The DB rows include all those keys.
  const insights = useMemo(() => {
    const fRows: ForecastResultRow[] = fr.map((r) => ({
      forecast_id:      r.forecast_id,
      forecast_date:    r.forecast_date,
      metric:           r.metric,
      predicted_value:  r.predicted_value,
      actual_value:     r.actual_value,
      confidence_level: r.confidence_level,
    }));
    const rRows: RecommendationResultRow[] = rr.map((r) => ({
      trade_id:              r.trade_id,
      market_id:             r.market_id,
      forecast_date:         r.forecast_date,
      signal:                r.signal,
      edge:                  r.edge,
      bracket_type:          r.bracket_type,
      recommended_size:      r.recommended_size,
      actually_placed:       r.actually_placed,
      actual_size:           r.actual_size,
      placed_at:             r.placed_at,
      would_have_won:        r.would_have_won,
      hypothetical_pnl:      r.hypothetical_pnl,
      normalized_pnl_at_10:  r.normalized_pnl_at_10,
      actual_pnl:            r.actual_pnl,
    }));
    return generateInsights(fRows, rRows).sort((a, b) => b.deviationScore - a.deviationScore).slice(0, 5);
  }, [fr, rr]);

  const noData = fr.length === 0 && rr.length === 0;

  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-2xl font-bold text-white">Performance</h1>
        <p className="text-sm text-slate-400 mt-1">
          Forecast accuracy and recommendation results — last 90 days.
        </p>
      </header>

      {/* Observations card */}
      <section className="bg-slate-800 border border-slate-700 rounded-xl p-5">
        <h2 className="text-white font-semibold text-base mb-3">Observations</h2>
        {insights.length > 0 ? (
          <ul className="space-y-2">
            {insights.map((ins, i) => (
              <li key={i} className="text-sm text-slate-200">
                <span className="text-slate-400 mr-2">•</span>
                {ins.text}
                <span className="text-slate-500 ml-2">(n={ins.n})</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-500">
            Not enough data yet — check back after 10+ days of settlements.
          </p>
        )}
      </section>

      {noData && <EmptyState />}

      {/* Section anchors for in-page nav */}
      <SectionNav />

      <ForecastAccuracy fr={fr} />
      <RecommendationPerformance rr={rr} />
      <CalibrationSection fr={fr} />
    </div>
  );
}

// ── Empty state ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-10 text-center text-slate-400">
      <p className="text-3xl mb-3">📊</p>
      <p className="font-medium">No data yet — run the daily settlement job after markets resolve.</p>
      <p className="text-xs mt-2 text-slate-500 font-mono">
        POST /api/daily-settlement {`{ "date": "YYYY-MM-DD" }`}
      </p>
    </div>
  );
}

function SectionNav() {
  const links = [
    ["#accuracy",        "Forecast Accuracy"],
    ["#recommendations", "Recommendations"],
    ["#calibration",     "Calibration"],
  ] as const;
  return (
    <nav className="flex gap-2 text-xs">
      {links.map(([href, label]) => (
        <a
          key={href}
          href={href}
          className="px-3 py-1.5 rounded-md border border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white transition-colors"
        >
          {label}
        </a>
      ))}
    </nav>
  );
}

// ── Section 1: Forecast Accuracy ─────────────────────────────────────────────

interface FRow {
  forecast_date:    string;
  metric:           "high" | "low" | "precip";
  predicted_value:  number;
  actual_value:     number;
  error:            number;
  abs_error:        number;
  confidence_level: ForecastConfidence;
}

function errorColor(absErr: number): string {
  if (absErr <= 1) return "text-emerald-400";
  if (absErr <= 2) return "text-amber-400";
  return "text-red-400";
}

function ForecastAccuracy({ fr }: { fr: FRow[] }) {
  // Group by date for daily table
  const byDate = useMemo(() => {
    const m = new Map<string, Partial<Record<"high" | "low" | "precip", FRow>>>();
    for (const r of fr) {
      if (!m.has(r.forecast_date)) m.set(r.forecast_date, {});
      m.get(r.forecast_date)![r.metric] = r;
    }
    return [...m.entries()]
      .map(([date, byMetric]) => ({ date, byMetric }))
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [fr]);

  const mae = useMemo(() => {
    const calc = (metric: "high" | "low", days: number): number | null => {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      const rows = fr.filter(
        (r) => r.metric === metric && new Date(r.forecast_date) >= cutoff,
      );
      if (rows.length === 0) return null;
      return rows.reduce((s, r) => s + r.abs_error, 0) / rows.length;
    };
    return {
      high7:  calc("high", 7),
      low7:   calc("low",  7),
      high30: calc("high", 30),
      low30:  calc("low",  30),
    };
  }, [fr]);

  // Rolling 30-day MAE per metric for the chart
  const rollingMae = useMemo(() => {
    const dates = [...new Set(fr.map((r) => r.forecast_date))].sort();
    const window = 30;
    return dates.map((date) => {
      const cutoff = new Date(date);
      cutoff.setDate(cutoff.getDate() - window);
      const inWindow = fr.filter((r) => {
        const d = new Date(r.forecast_date);
        return d <= new Date(date) && d >= cutoff;
      });
      const meanAbs = (m: "high" | "low" | "precip") => {
        const xs = inWindow.filter((r) => r.metric === m);
        if (xs.length === 0) return null;
        return xs.reduce((s, r) => s + r.abs_error, 0) / xs.length;
      };
      return {
        date,
        high:   meanAbs("high"),
        low:    meanAbs("low"),
        precip: meanAbs("precip"),
      };
    });
  }, [fr]);

  // Bias by ISO week
  const weeklyBias = useMemo(() => {
    const buckets = new Map<string, { high: number[]; low: number[] }>();
    for (const r of fr) {
      if (r.metric === "precip") continue;
      const d = new Date(r.forecast_date);
      const week = `${d.getFullYear()}-W${String(Math.ceil(((d.getTime() - new Date(d.getFullYear(), 0, 1).getTime()) / 86400000 + 1) / 7)).padStart(2, "0")}`;
      if (!buckets.has(week)) buckets.set(week, { high: [], low: [] });
      const arr = r.metric === "high" ? buckets.get(week)!.high : buckets.get(week)!.low;
      arr.push(r.error);
    }
    return [...buckets.entries()]
      .map(([week, e]) => ({
        week,
        highBias: e.high.length ? e.high.reduce((s, x) => s + x, 0) / e.high.length : 0,
        lowBias:  e.low.length  ? e.low.reduce((s, x)  => s + x, 0) / e.low.length  : 0,
      }))
      .sort((a, b) => a.week.localeCompare(b.week));
  }, [fr]);

  const topErrors = useMemo(() => {
    return [...fr]
      .filter((r) => r.metric !== "precip")
      .sort((a, b) => b.abs_error - a.abs_error)
      .slice(0, 10);
  }, [fr]);

  const hasData = fr.length > 0;

  return (
    <section id="accuracy" className="space-y-5 scroll-mt-20">
      <h2 className="text-xl font-bold text-white">Forecast Accuracy</h2>
      {!hasData ? (
        <p className="text-sm text-slate-500">
          No forecast results yet — run the daily settlement job to populate.
        </p>
      ) : (
        <>
          {/* MAE summary cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <MaeCard label="7-day MAE (high)"  value={mae.high7} />
            <MaeCard label="7-day MAE (low)"   value={mae.low7} />
            <MaeCard label="30-day MAE (high)" value={mae.high30} />
            <MaeCard label="30-day MAE (low)"  value={mae.low30} />
          </div>

          {/* Rolling MAE line chart */}
          <ChartCard title="Rolling 30-day MAE">
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={rollingMae}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="date" stroke="#94a3b8" fontSize={11} />
                <YAxis stroke="#94a3b8" fontSize={11} />
                <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid #334155", color: "#f1f5f9" }} />
                <Line type="monotone" dataKey="high"   stroke="#10b981" name="High °F" dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="low"    stroke="#0ea5e9" name="Low °F"  dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="precip" stroke="#8b5cf6" name="Precip pp" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Bias bar chart */}
          <ChartCard title="Weekly bias (signed mean error — positive = forecast too high)">
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={weeklyBias}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="week" stroke="#94a3b8" fontSize={11} />
                <YAxis stroke="#94a3b8" fontSize={11} />
                <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid #334155", color: "#f1f5f9" }} />
                <ReferenceLine y={0} stroke="#64748b" />
                <Bar dataKey="highBias" name="High bias °F" fill="#10b981" />
                <Bar dataKey="lowBias"  name="Low bias °F"  fill="#0ea5e9" />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Daily table */}
          <ChartCard title="Daily results">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 uppercase tracking-wider border-b border-slate-700/50">
                    <th className="py-2 pr-4">Date</th>
                    <th className="py-2 pr-4">Pred high</th>
                    <th className="py-2 pr-4">Actual high</th>
                    <th className="py-2 pr-4">Err</th>
                    <th className="py-2 pr-4">Pred low</th>
                    <th className="py-2 pr-4">Actual low</th>
                    <th className="py-2 pr-4">Err</th>
                    <th className="py-2 pr-4">Precip%</th>
                    <th className="py-2 pr-4">Rained?</th>
                    <th className="py-2">Conf</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/30">
                  {byDate.slice(0, 30).map(({ date, byMetric }) => {
                    const h = byMetric.high;
                    const l = byMetric.low;
                    const p = byMetric.precip;
                    const conf = h?.confidence_level ?? l?.confidence_level ?? p?.confidence_level ?? "confident";
                    return (
                      <tr key={date} className="text-slate-200">
                        <td className="py-2 pr-4 text-slate-400 whitespace-nowrap">{date}</td>
                        <td className="py-2 pr-4">{h ? h.predicted_value : "—"}</td>
                        <td className="py-2 pr-4">{h ? h.actual_value : "—"}</td>
                        <td className={`py-2 pr-4 font-medium ${h ? errorColor(h.abs_error) : ""}`}>
                          {h ? `${h.error > 0 ? "+" : ""}${h.error.toFixed(1)}°` : "—"}
                        </td>
                        <td className="py-2 pr-4">{l ? l.predicted_value : "—"}</td>
                        <td className="py-2 pr-4">{l ? l.actual_value : "—"}</td>
                        <td className={`py-2 pr-4 font-medium ${l ? errorColor(l.abs_error) : ""}`}>
                          {l ? `${l.error > 0 ? "+" : ""}${l.error.toFixed(1)}°` : "—"}
                        </td>
                        <td className="py-2 pr-4">{p ? `${p.predicted_value}%` : "—"}</td>
                        <td className="py-2 pr-4">{p ? (p.actual_value >= 50 ? "Yes" : "No") : "—"}</td>
                        <td className="py-2 text-xs text-slate-400">{conf.replace("_", " ")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </ChartCard>

          {/* Top errors */}
          <ChartCard title="Top 10 highest-error days">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 uppercase tracking-wider border-b border-slate-700/50">
                    <th className="py-2 pr-4">Date</th>
                    <th className="py-2 pr-4">Metric</th>
                    <th className="py-2 pr-4">Predicted</th>
                    <th className="py-2 pr-4">Actual</th>
                    <th className="py-2 pr-4">Error</th>
                    <th className="py-2">Confidence</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/30">
                  {topErrors.map((r) => (
                    <tr key={`${r.forecast_date}-${r.metric}`} className="text-slate-200">
                      <td className="py-2 pr-4 text-slate-400">{r.forecast_date}</td>
                      <td className="py-2 pr-4">{r.metric}</td>
                      <td className="py-2 pr-4">{r.predicted_value}</td>
                      <td className="py-2 pr-4">{r.actual_value}</td>
                      <td className={`py-2 pr-4 font-medium ${errorColor(r.abs_error)}`}>
                        {r.error > 0 ? "+" : ""}{r.error.toFixed(1)}
                      </td>
                      <td className="py-2 text-xs text-slate-400">{r.confidence_level.replace("_", " ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </ChartCard>
        </>
      )}
    </section>
  );
}

function MaeCard({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
      <p className="text-xs text-slate-500 uppercase tracking-wider">{label}</p>
      <p className="text-2xl font-bold mt-1 text-white">
        {value == null ? "—" : `${value.toFixed(2)}°`}
      </p>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
      <h3 className="text-sm font-semibold text-slate-200 mb-4">{title}</h3>
      {children}
    </div>
  );
}

// ── Section 2: Recommendation Performance ────────────────────────────────────

interface RRow {
  forecast_date:        string;
  signal:               string;
  edge:                 number;
  bracket_type:         "forecast" | "adjacent_low" | "adjacent_high" | "other";
  would_have_won:       boolean;
  hypothetical_pnl:     number;
  normalized_pnl_at_10: number;
  actual_pnl:           number | null;
}

function RecommendationPerformance({ rr }: { rr: RRow[] }) {
  const cumulative = useMemo(() => {
    const sorted = [...rr].sort((a, b) => a.forecast_date.localeCompare(b.forecast_date));
    let cumActual = 0;
    let cumHypo   = 0;
    return sorted.map((r) => {
      if (r.actual_pnl != null) cumActual += r.actual_pnl;
      cumHypo += r.hypothetical_pnl;
      return {
        date:        r.forecast_date,
        actual:      r.actual_pnl != null ? cumActual : null,
        hypothetical: cumHypo,
      };
    });
  }, [rr]);

  const winRate = (rows: RRow[]): { rate: number | null; n: number; wins: number } => {
    if (rows.length === 0) return { rate: null, n: 0, wins: 0 };
    const wins = rows.filter((r) => r.would_have_won).length;
    return { rate: wins / rows.length, n: rows.length, wins };
  };

  const avg = (rows: RRow[], key: "hypothetical_pnl" | "normalized_pnl_at_10" | "actual_pnl"): number | null => {
    if (rows.length === 0) return null;
    const xs = rows.map((r) => r[key]).filter((x): x is number => x != null);
    if (xs.length === 0) return null;
    return xs.reduce((s, x) => s + x, 0) / xs.length;
  };

  const overall = winRate(rr);
  const strongBuy = winRate(rr.filter((r) => r.signal === "strong-buy"));
  const buy       = winRate(rr.filter((r) => r.signal === "buy"));

  const segments: Array<{ label: string; rows: RRow[] }> = [
    { label: "Strong Buy", rows: rr.filter((r) => r.signal === "strong-buy") },
    { label: "Buy",        rows: rr.filter((r) => r.signal === "buy") },
    { label: "Edge 5–10pt",   rows: rr.filter((r) => r.edge >= 5  && r.edge < 10) },
    { label: "Edge 10–25pt",  rows: rr.filter((r) => r.edge >= 10 && r.edge < 25) },
    { label: "Edge 25pt+",    rows: rr.filter((r) => r.edge >= 25) },
    { label: "Forecast bracket",      rows: rr.filter((r) => r.bracket_type === "forecast") },
    { label: "Adjacent low bracket",  rows: rr.filter((r) => r.bracket_type === "adjacent_low") },
    { label: "Adjacent high bracket", rows: rr.filter((r) => r.bracket_type === "adjacent_high") },
  ];

  const hasData = rr.length > 0;

  return (
    <section id="recommendations" className="space-y-5 scroll-mt-20">
      <h2 className="text-xl font-bold text-white">Recommendation Performance</h2>
      {!hasData ? (
        <p className="text-sm text-slate-500">
          No recommendation results yet — run the daily settlement job.
        </p>
      ) : (
        <>
          <ChartCard title="Cumulative P&L">
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={cumulative}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="date" stroke="#94a3b8" fontSize={11} />
                <YAxis stroke="#94a3b8" fontSize={11} />
                <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid #334155", color: "#f1f5f9" }} />
                <Line type="monotone" dataKey="actual"       stroke="#10b981" name="Actual P&L"        dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="hypothetical" stroke="#0ea5e9" name="Hypothetical P&L"  dot={false} strokeWidth={2} strokeDasharray="5 4" />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <RateCard label="Overall win rate"     rate={overall.rate}     n={overall.n} />
            <RateCard label="Strong-buy win rate"  rate={strongBuy.rate}   n={strongBuy.n} />
            <RateCard label="Buy win rate"         rate={buy.rate}         n={buy.n} />
          </div>

          <ChartCard title="Segment breakdown">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 uppercase tracking-wider border-b border-slate-700/50">
                    <th className="py-2 pr-4">Segment</th>
                    <th className="py-2 pr-4">n</th>
                    <th className="py-2 pr-4">Win rate</th>
                    <th className="py-2 pr-4">Avg actual P&L</th>
                    <th className="py-2">Avg normalized P&L ($10)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/30">
                  {segments.map((s) => {
                    const wr  = winRate(s.rows);
                    const ap  = avg(s.rows, "actual_pnl");
                    const np  = avg(s.rows, "normalized_pnl_at_10");
                    const low = wr.n < 5;
                    return (
                      <tr key={s.label} className={`text-slate-200 ${low ? "opacity-50" : ""}`}>
                        <td className="py-2 pr-4">{s.label}</td>
                        <td className="py-2 pr-4">{wr.n}</td>
                        <td className="py-2 pr-4">
                          {wr.rate == null ? "—" : `${Math.round(wr.rate * 100)}%`}
                          {low && <span className="text-xs text-slate-500 ml-1">(low sample)</span>}
                        </td>
                        <td className={`py-2 pr-4 ${ap == null ? "text-slate-500" : ap >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {ap == null ? "—" : `${ap >= 0 ? "+" : ""}$${ap.toFixed(2)}`}
                        </td>
                        <td className={`py-2 ${np == null ? "text-slate-500" : np >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {np == null ? "—" : `${np >= 0 ? "+" : ""}$${np.toFixed(2)}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </ChartCard>
        </>
      )}
    </section>
  );
}

function RateCard({ label, rate, n }: { label: string; rate: number | null; n: number }) {
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
      <p className="text-xs text-slate-500 uppercase tracking-wider">{label}</p>
      <p className="text-2xl font-bold mt-1 text-white">
        {rate == null ? "—" : `${Math.round(rate * 100)}%`}
      </p>
      <p className="text-xs text-slate-500 mt-0.5">n = {n}</p>
    </div>
  );
}

// ── Section 3: Calibration ───────────────────────────────────────────────────

function CalibrationSection({ fr }: { fr: FRow[] }) {
  const precip = useMemo(() => fr.filter((r) => r.metric === "precip"), [fr]);

  // Calibration bins
  const calibration = useMemo(() => {
    return CALIBRATION_BINS.map((bin, i) => {
      const inBin = precip.filter((r) => calibrationBin(r.predicted_value) === i);
      const hits  = inBin.filter((r) => r.actual_value >= 50).length;
      return {
        label:     bin.label,
        midpoint:  (bin.lo + bin.hi) / 2,
        hitRate:   inBin.length === 0 ? null : (hits / inBin.length) * 100,
        n:         inBin.length,
      };
    });
  }, [precip]);

  // Per-confidence-level temperature std-dev (60-day window)
  const stdByConfidence = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 60);
    const results: Array<{ level: ForecastConfidence; stated: number; actual: number | null; n: number }> = [];
    for (const level of ["very_confident", "confident", "uncertain"] as const) {
      const xs = fr
        .filter((r) =>
          (r.metric === "high" || r.metric === "low") &&
          r.confidence_level === level &&
          new Date(r.forecast_date) >= cutoff,
        )
        .map((r) => r.error);
      results.push({
        level,
        stated: STATED_STD_BY_CONFIDENCE[level],
        actual: xs.length >= 2 ? stdDev(xs) : null,
        n:      xs.length,
      });
    }
    return results;
  }, [fr]);

  const hasData = fr.length > 0;

  return (
    <section id="calibration" className="space-y-5 scroll-mt-20">
      <h2 className="text-xl font-bold text-white">Calibration</h2>
      {!hasData ? (
        <p className="text-sm text-slate-500">No data yet — run the daily settlement job.</p>
      ) : (
        <>
          <ChartCard title="Precipitation calibration curve (predicted % vs actual hit rate)">
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={calibration}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="midpoint" type="number" domain={[0, 100]} stroke="#94a3b8" fontSize={11} />
                <YAxis yAxisId="left" type="number" domain={[0, 100]} stroke="#94a3b8" fontSize={11} />
                <YAxis yAxisId="right" orientation="right" stroke="#475569" fontSize={11} />
                <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid #334155", color: "#f1f5f9" }} />
                <ReferenceLine yAxisId="left" stroke="#64748b" strokeDasharray="4 4" segment={[{ x: 0, y: 0 }, { x: 100, y: 100 }]} />
                <Bar yAxisId="right" dataKey="n" fill="#475569" name="Sample size" />
                <Scatter yAxisId="left" dataKey="hitRate" fill="#8b5cf6" name="Actual hit rate" />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Confidence-level calibration (temperature std dev, last 60 days)">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 uppercase tracking-wider border-b border-slate-700/50">
                    <th className="py-2 pr-4">Level</th>
                    <th className="py-2 pr-4">Stated std dev</th>
                    <th className="py-2 pr-4">Actual std dev</th>
                    <th className="py-2 pr-4">Sample n</th>
                    <th className="py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/30">
                  {stdByConfidence.map((row) => {
                    const lowSample = row.n < 10;
                    const miscal    = row.actual != null && Math.abs(row.actual - row.stated) / row.stated > 0.2;
                    return (
                      <tr key={row.level} className="text-slate-200">
                        <td className="py-2 pr-4 capitalize">{row.level.replace("_", " ")}</td>
                        <td className="py-2 pr-4">{row.stated.toFixed(1)}°</td>
                        <td className="py-2 pr-4">{row.actual == null ? "—" : `${row.actual.toFixed(2)}°`}</td>
                        <td className="py-2 pr-4">{row.n}</td>
                        <td className="py-2 text-xs">
                          {lowSample && <span className="text-amber-400">⚠️ Low sample</span>}
                          {!lowSample && miscal && <span className="text-amber-400">⚠️ Miscalibrated</span>}
                          {!lowSample && !miscal && row.actual != null && <span className="text-emerald-400">OK</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </ChartCard>
        </>
      )}
    </section>
  );
}
