"use client";

import { useState } from "react";
import Link from "next/link";

// ── helpers ──────────────────────────────────────────────────────────────────

function addDays(base: Date, n: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d;
}

function toISODate(d: Date): string {
  return d.toISOString().split("T")[0];
}

type PrecipType = "None" | "Rain" | "Snow" | "Mix";
type RowStatus  = "saved" | "unsaved" | "saving" | "error";
type Confidence = "very_confident" | "confident" | "uncertain";

// Note: order is Low→Medium→High so the visual left-to-right matches
// the conceptual "narrow ← → wide" uncertainty spectrum.
const CONFIDENCE_OPTIONS: { value: Confidence; label: string; std: string }[] = [
  { value: "uncertain",      label: "Low",    std: "±4°"   },
  { value: "confident",      label: "Medium", std: "±2°"   },
  { value: "very_confident", label: "High",   std: "±1.5°" },
];

interface DayRow {
  high_temp:           string;
  low_temp:            string;
  precip_chance:       string;
  precip_type:         PrecipType; // kept for DB / future precip markets
  forecast_confidence: Confidence;
  status:              RowStatus;
}

function weatherIcon(precip: string, type: PrecipType): string {
  const p = Number(precip) || 0;
  if (type === "Snow") return "🌨️";
  if (type === "Mix")  return "🌩️";
  if (p < 20) return "☀️";
  if (p < 40) return "🌤️";
  if (p < 70) return "🌧️";
  return "⛈️";
}

function highTempClass(val: string): string {
  const n = Number(val);
  if (!val || isNaN(n)) return "text-slate-100";
  if (n >= 90) return "text-red-400 font-bold";
  if (n >= 80) return "text-orange-400 font-bold";
  if (n < 32)  return "text-sky-300 font-bold";
  return "text-slate-100";
}

const DAY_SHORT   = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayLabel(date: Date, index: number): { top: string; bottom: string } {
  if (index === 0) return { top: "Today",    bottom: `${MONTH_SHORT[date.getMonth()]} ${date.getDate()}` };
  if (index === 1) return { top: "Tomorrow", bottom: `${MONTH_SHORT[date.getMonth()]} ${date.getDate()}` };
  return { top: DAY_SHORT[date.getDay()], bottom: `${MONTH_SHORT[date.getMonth()]} ${date.getDate()}` };
}

// ── component ────────────────────────────────────────────────────────────────

interface Props {
  today: string;
  initialDays: {
    high_temp:           number | null;
    low_temp:            number | null;
    precip_chance:       number | null;
    precip_type?:        string | null;
    forecast_confidence?: string | null;
  }[];
}

export default function ForecastForm({ today, initialDays }: Props) {
  const todayDate = new Date(today + "T12:00:00");

  const [rows, setRows] = useState<DayRow[]>(() =>
    Array.from({ length: 7 }, (_, i) => {
      const d = initialDays[i];
      const hasData = d?.high_temp != null || d?.low_temp != null || d?.precip_chance != null;
      return {
        high_temp:           d?.high_temp     != null ? String(d.high_temp)     : "",
        low_temp:            d?.low_temp      != null ? String(d.low_temp)      : "",
        precip_chance:       d?.precip_chance != null ? String(d.precip_chance) : "",
        precip_type:         (d?.precip_type as PrecipType) ?? "None",
        forecast_confidence: (d?.forecast_confidence as Confidence) ?? "very_confident",
        status:              hasData ? "saved" : "unsaved",
      };
    })
  );

  function updateField(i: number, field: keyof Omit<DayRow, "status">, value: string) {
    setRows((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], [field]: value, status: "unsaved" };
      return next;
    });
  }

  function handleCardBlur(i: number, e: React.FocusEvent<HTMLDivElement>) {
    const related = e.relatedTarget as Node | null;
    if (!related || !e.currentTarget.contains(related)) {
      saveRow(i);
    }
  }

  async function saveRow(i: number) {
    const row = rows[i];
    if (row.status === "saved" || row.status === "saving") return;
    if (row.high_temp === "" && row.low_temp === "" && row.precip_chance === "") return;

    setRows((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], status: "saving" };
      return next;
    });

    try {
      const res = await fetch("/api/forecast/day", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          forecast_date:       today,
          day_index:           i,
          target_date:         toISODate(addDays(todayDate, i)),
          high_temp:           row.high_temp    !== "" ? Number(row.high_temp)    : null,
          low_temp:            row.low_temp     !== "" ? Number(row.low_temp)     : null,
          precip_chance:       row.precip_chance !== "" ? Number(row.precip_chance) : null,
          precip_type:         row.precip_type,
          forecast_confidence: row.forecast_confidence,
        }),
      });

      const json = await res.json();
      setRows((prev) => {
        const next = [...prev];
        next[i] = { ...next[i], status: res.ok ? "saved" : "error" };
        return next;
      });
      if (!res.ok) console.error(`[forecast] save row ${i}:`, json.error);
    } catch {
      setRows((prev) => {
        const next = [...prev];
        next[i] = { ...next[i], status: "error" };
        return next;
      });
    }
  }

  const anySaved = rows.some((r) => r.status === "saved");

  return (
    <div className="space-y-4 pb-28">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-white">7-Day Forecast</h1>
        <p className="text-slate-400 text-sm mt-0.5">Philadelphia — saves when you leave a card</p>
      </div>

      {/* 7-day grid */}
      <div className="overflow-x-auto pb-2">
        <div className="flex gap-3" style={{ minWidth: "896px" }}>
          {rows.map((row, i) => {
            const date = addDays(todayDate, i);
            const { top, bottom } = dayLabel(date, i);
            const icon = weatherIcon(row.precip_chance, row.precip_type);

            return (
              <div
                key={i}
                tabIndex={-1}
                onBlur={(e) => handleCardBlur(i, e)}
                style={{ width: "calc((896px - 6 * 12px) / 7)", flexShrink: 0 }}
                className={`relative bg-slate-800 border rounded-xl p-3 flex flex-col gap-2 focus-within:border-sky-600 transition-colors ${
                  row.status === "error"
                    ? "border-red-500/60"
                    : row.status === "saved"
                    ? "border-green-500/30"
                    : "border-slate-700"
                }`}
              >
                {/* Day header */}
                <div className="text-center">
                  <div className="text-sm font-bold text-white leading-tight">{top}</div>
                  <div className="text-xs text-slate-400">{bottom}</div>
                  <div className="text-xl mt-0.5">{icon}</div>
                </div>

                {/* Fields */}
                <div className="space-y-1.5">
                  <Field
                    label="High °F"
                    value={row.high_temp}
                    placeholder="—"
                    onChange={(v) => updateField(i, "high_temp", v)}
                    inputClass={highTempClass(row.high_temp)}
                  />
                  <Field
                    label="Low °F"
                    value={row.low_temp}
                    placeholder="—"
                    onChange={(v) => updateField(i, "low_temp", v)}
                  />
                  <Field
                    label="Precip %"
                    value={row.precip_chance}
                    placeholder="—"
                    min={0}
                    max={100}
                    onChange={(v) => updateField(i, "precip_chance", v)}
                  />
                </div>

                {/* Confidence — segmented toggle */}
                <div className="flex rounded-lg p-1" style={{ background: "rgba(255,255,255,0.06)" }}>
                  {CONFIDENCE_OPTIONS.map((opt) => {
                    const selected = row.forecast_confidence === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        title={`Std dev ${opt.std}`}
                        onClick={() => updateField(i, "forecast_confidence", opt.value)}
                        className={`flex-1 rounded-md py-1 text-xs font-medium text-center transition-colors ${
                          selected
                            ? "bg-white/20 text-white"
                            : "text-gray-500 hover:text-gray-400"
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>

                {/* Status badge */}
                <div className="absolute top-2 right-2">
                  {row.status === "saving" && (
                    <span className="text-sky-400 text-sm animate-pulse">…</span>
                  )}
                  {row.status === "saved" && (
                    <span className="text-emerald-400 text-base leading-none">✓</span>
                  )}
                  {row.status === "error" && (
                    <span className="text-red-400 text-sm" title="Save failed">!</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Sticky View Markets button */}
      {anySaved && (
        <div className="fixed bottom-0 right-0 left-0 z-50 flex justify-end px-6 py-4 backdrop-blur-sm bg-gray-900/80">
          <Link
            href="/markets"
            className="flex items-center gap-2 bg-sky-500 hover:bg-sky-400 text-white font-semibold px-5 py-3 rounded-xl shadow-xl shadow-sky-500/20 transition-colors text-sm"
          >
            View Markets →
          </Link>
        </div>
      )}
    </div>
  );
}

// ── Field sub-component ───────────────────────────────────────────────────────

function Field({
  label,
  value,
  placeholder,
  onChange,
  min,
  max,
  inputClass = "text-slate-100",
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  min?: number;
  max?: number;
  inputClass?: string;
}) {
  return (
    <div>
      <label className="block text-xs text-slate-500 mb-0.5">{label}</label>
      <input
        type="number"
        value={value}
        placeholder={placeholder}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full bg-slate-700 border border-slate-600 rounded-md px-2 py-1 text-sm text-center focus:outline-none focus:ring-1 focus:ring-sky-500 placeholder:text-slate-600 ${inputClass}`}
      />
    </div>
  );
}
