"use client";

import { useRef, useState } from "react";
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
type RowStatus = "saved" | "unsaved" | "saving" | "error";
type Confidence = "very_confident" | "confident" | "uncertain";

const CONFIDENCE_OPTIONS: { value: Confidence; label: string; std: string }[] = [
  { value: "very_confident", label: "High",   std: "±1°"  },
  { value: "confident",      label: "Normal", std: "±2°"  },
  { value: "uncertain",      label: "Low",    std: "±4°"  },
];

const PRECIP_TYPES: { value: PrecipType; label: string }[] = [
  { value: "None", label: "None" },
  { value: "Rain", label: "Rain" },
  { value: "Snow", label: "Snow" },
  { value: "Mix",  label: "Mix"  },
];

interface DayRow {
  high_temp: string;
  low_temp: string;
  precip_chance: string;
  precip_type: PrecipType;
  forecast_confidence: Confidence;
  status: RowStatus;
}

function weatherIcon(precip: string, type: PrecipType): string {
  const p = Number(precip) || 0;
  if (type === "Snow") return "🌨️";
  if (type === "Mix") return "🌩️";
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
  if (n < 32) return "text-sky-300 font-bold";
  return "text-slate-100";
}

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayLabel(date: Date, index: number): { top: string; bottom: string } {
  if (index === 0) return { top: "Today",    bottom: `${MONTH_SHORT[date.getMonth()]} ${date.getDate()}` };
  if (index === 1) return { top: "Tomorrow", bottom: `${MONTH_SHORT[date.getMonth()]} ${date.getDate()}` };
  return { top: DAY_SHORT[date.getDay()], bottom: `${MONTH_SHORT[date.getMonth()]} ${date.getDate()}` };
}

/** Label shown in the summary strip (compact) */
function stripLabel(index: number, date: Date): string {
  if (index === 0) return "Today";
  if (index === 1) return "Tmrw";
  return DAY_SHORT[date.getDay()];
}

// ── Pill sub-component ────────────────────────────────────────────────────────

function Pill({
  label,
  selected,
  title,
  onClick,
}: {
  label: string;
  selected: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
        selected
          ? "bg-blue-500 text-white border-blue-500"
          : "border-gray-600 text-gray-400 hover:border-gray-400"
      }`}
    >
      {label}
    </button>
  );
}

// ── component ────────────────────────────────────────────────────────────────

interface Props {
  today: string;
  initialDays: { high_temp: number | null; low_temp: number | null; precip_chance: number | null; precip_type?: string | null; forecast_confidence?: string | null }[];
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
        forecast_confidence: (d?.forecast_confidence as Confidence) ?? "confident",
        status:              hasData ? "saved" : "unsaved",
      };
    })
  );

  // Refs for each day card — used by the summary strip to scroll to the card
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);

  function updateField(i: number, field: keyof Omit<DayRow, "status">, value: string) {
    setRows((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], [field]: value, status: "unsaved" };
      return next;
    });
  }

  // Save triggered when focus leaves a card entirely (not just between fields in same card)
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
    } catch (err) {
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
        <p className="text-slate-400 text-sm mt-0.5">Philadelphia — edit any field, saves when you leave the card</p>
      </div>

      {/* Summary strip — each chip scrolls to its day card */}
      <div className="overflow-x-auto">
        <div className="flex gap-2 min-w-max py-1">
          {rows.map((row, i) => {
            const date  = addDays(todayDate, i);
            const label = stripLabel(i, date);
            const icon  = weatherIcon(row.precip_chance, row.precip_type);
            return (
              <button
                key={i}
                type="button"
                onClick={() =>
                  cardRefs.current[i]?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" })
                }
                className="flex items-center gap-1.5 bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-xs hover:border-slate-500 transition-colors cursor-pointer"
              >
                <span className="text-slate-400 font-medium">{label}</span>
                <span>{icon}</span>
                {row.high_temp || row.low_temp ? (
                  <span className={`font-semibold ${highTempClass(row.high_temp)}`}>
                    {row.high_temp || "—"}°
                  </span>
                ) : null}
                {row.low_temp ? (
                  <span className="text-slate-400">{row.low_temp}°</span>
                ) : null}
                {!row.high_temp && !row.low_temp && (
                  <span className="text-slate-600">—</span>
                )}
              </button>
            );
          })}
        </div>
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
                ref={(el) => { cardRefs.current[i] = el; }}
                tabIndex={-1}
                onBlur={(e) => handleCardBlur(i, e)}
                style={{ width: "calc((896px - 6 * 12px) / 7)", flexShrink: 0 }}
                className={`relative bg-slate-800 border rounded-xl p-3 flex flex-col gap-3 focus-within:border-sky-600 transition-colors ${
                  row.status === "error"
                    ? "border-red-500/60"
                    : row.status === "saved"
                    ? "border-green-500/30"
                    : "border-slate-700"
                }`}
              >
                {/* Day header */}
                <div className="text-center">
                  <div className="text-sm font-bold text-white">{top}</div>
                  <div className="text-xs text-slate-400">{bottom}</div>
                  <div className="text-2xl mt-1">{icon}</div>
                </div>

                {/* Fields */}
                <div className="space-y-2">
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

                  {/* Precip type — pill buttons */}
                  <div>
                    <label className="block text-xs text-slate-500 mb-1.5">Type</label>
                    <div className="flex flex-wrap gap-1">
                      {PRECIP_TYPES.map((opt) => (
                        <Pill
                          key={opt.value}
                          label={opt.label}
                          selected={row.precip_type === opt.value}
                          onClick={() => updateField(i, "precip_type", opt.value)}
                        />
                      ))}
                    </div>
                  </div>

                  {/* Confidence — pill buttons */}
                  <div>
                    <label className="block text-xs text-slate-500 mb-1.5">Confidence</label>
                    <div className="flex flex-wrap gap-1">
                      {CONFIDENCE_OPTIONS.map((opt) => (
                        <Pill
                          key={opt.value}
                          label={opt.label}
                          selected={row.forecast_confidence === opt.value}
                          title={`Std dev ${opt.std}`}
                          onClick={() => updateField(i, "forecast_confidence", opt.value)}
                        />
                      ))}
                    </div>
                  </div>
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
      <label className="block text-xs text-slate-500 mb-1">{label}</label>
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
