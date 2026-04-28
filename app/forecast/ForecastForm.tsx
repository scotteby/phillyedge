"use client";

import { useState, useRef } from "react";
import Link from "next/link";

function addDays(base: Date, n: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d;
}

function toISODate(d: Date): string {
  return d.toISOString().split("T")[0];
}

function formatDayLabel(d: Date, short = false): string {
  return d.toLocaleDateString("en-US", short
    ? { weekday: "short", month: "numeric", day: "numeric" }
    : { weekday: "short", month: "short", day: "numeric" }
  );
}

type RowStatus = "saved" | "unsaved" | "saving" | "error";

interface DayRow {
  high_temp: string;
  low_temp: string;
  precip_chance: string;
  status: RowStatus;
}

interface Props {
  today: string; // YYYY-MM-DD, formatted server-side
  initialDays: { high_temp: number | null; low_temp: number | null; precip_chance: number | null }[];
}

export default function ForecastForm({ today, initialDays }: Props) {
  const todayDate = new Date(today + "T12:00:00"); // noon to avoid DST edge

  const [rows, setRows] = useState<DayRow[]>(() =>
    Array.from({ length: 7 }, (_, i) => {
      const d = initialDays[i];
      const hasData = d && (d.high_temp != null || d.low_temp != null || d.precip_chance != null);
      return {
        high_temp: d?.high_temp != null ? String(d.high_temp) : "",
        low_temp: d?.low_temp != null ? String(d.low_temp) : "",
        precip_chance: d?.precip_chance != null ? String(d.precip_chance) : "",
        status: hasData ? "saved" : "unsaved",
      };
    })
  );

  // Track which fields are currently focused so we don't auto-save while typing
  const focusedRow = useRef<number | null>(null);

  function updateField(i: number, field: keyof Omit<DayRow, "status">, value: string) {
    setRows((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], [field]: value, status: "unsaved" };
      return next;
    });
  }

  async function saveRow(i: number) {
    const row = rows[i];
    // Skip save if all fields are empty
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
          forecast_date: today,
          day_index: i,
          target_date: toISODate(addDays(todayDate, i)),
          high_temp: row.high_temp !== "" ? Number(row.high_temp) : null,
          low_temp: row.low_temp !== "" ? Number(row.low_temp) : null,
          precip_chance: row.precip_chance !== "" ? Number(row.precip_chance) : null,
        }),
      });

      const json = await res.json();
      setRows((prev) => {
        const next = [...prev];
        next[i] = { ...next[i], status: res.ok ? "saved" : "error" };
        return next;
      });
      if (!res.ok) console.error("Save failed:", json.error);
    } catch (err) {
      setRows((prev) => {
        const next = [...prev];
        next[i] = { ...next[i], status: "error" };
        return next;
      });
    }
  }

  function handleBlur(i: number) {
    // Only save if no other field in this row is immediately focused
    setTimeout(() => {
      if (focusedRow.current !== i) saveRow(i);
    }, 50);
  }

  const allSaved = rows.every((r) => r.status === "saved" || (r.high_temp === "" && r.low_temp === "" && r.precip_chance === ""));
  const anySaved = rows.some((r) => r.status === "saved");

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">7-Day Forecast</h1>
          <p className="text-slate-400 text-sm mt-0.5">Philadelphia — edit any field, saves automatically</p>
        </div>
        {anySaved && (
          <Link
            href="/markets"
            className="shrink-0 bg-sky-500 hover:bg-sky-400 text-white font-semibold px-5 py-2 rounded-xl transition-colors text-sm"
          >
            View Markets →
          </Link>
        )}
      </div>

      {/* Table */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
        {/* Header row */}
        <div className="grid grid-cols-[2fr_1fr_1fr_1fr_24px] gap-0 px-4 py-2 border-b border-slate-700 text-xs font-semibold text-slate-500 uppercase tracking-wider">
          <div>Day</div>
          <div>High °F</div>
          <div>Low °F</div>
          <div>Precip %</div>
          <div />
        </div>

        {/* Day rows */}
        {rows.map((row, i) => {
          const date = addDays(todayDate, i);
          const dayLabel = i === 0 ? "Today" : i === 1 ? "Tomorrow" : formatDayLabel(date, true);

          return (
            <div
              key={i}
              className="grid grid-cols-[2fr_1fr_1fr_1fr_24px] gap-0 items-center px-4 border-b border-slate-700/50 last:border-0 hover:bg-slate-700/20 transition-colors"
            >
              {/* Day label */}
              <div className="py-3 pr-4">
                <span className="font-medium text-white text-sm">{dayLabel}</span>
              </div>

              {/* High temp */}
              <div className="py-2 pr-3">
                <input
                  type="number"
                  value={row.high_temp}
                  placeholder="—"
                  onFocus={() => (focusedRow.current = i)}
                  onBlur={() => { focusedRow.current = null; handleBlur(i); }}
                  onChange={(e) => updateField(i, "high_temp", e.target.value)}
                  className="w-full bg-transparent border-b border-slate-600 focus:border-sky-500 outline-none text-white text-sm py-1 text-center placeholder:text-slate-600 transition-colors"
                />
              </div>

              {/* Low temp */}
              <div className="py-2 pr-3">
                <input
                  type="number"
                  value={row.low_temp}
                  placeholder="—"
                  onFocus={() => (focusedRow.current = i)}
                  onBlur={() => { focusedRow.current = null; handleBlur(i); }}
                  onChange={(e) => updateField(i, "low_temp", e.target.value)}
                  className="w-full bg-transparent border-b border-slate-600 focus:border-sky-500 outline-none text-white text-sm py-1 text-center placeholder:text-slate-600 transition-colors"
                />
              </div>

              {/* Precip % */}
              <div className="py-2 pr-3">
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={row.precip_chance}
                  placeholder="—"
                  onFocus={() => (focusedRow.current = i)}
                  onBlur={() => { focusedRow.current = null; handleBlur(i); }}
                  onChange={(e) => updateField(i, "precip_chance", e.target.value)}
                  className="w-full bg-transparent border-b border-slate-600 focus:border-sky-500 outline-none text-white text-sm py-1 text-center placeholder:text-slate-600 transition-colors"
                />
              </div>

              {/* Status dot */}
              <div className="flex items-center justify-center">
                <StatusDot status={row.status} />
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer hint */}
      <p className="text-xs text-slate-600 text-center">
        Fields save automatically when you move to the next one
      </p>
    </div>
  );
}

function StatusDot({ status }: { status: RowStatus }) {
  if (status === "saving") {
    return <span className="w-2 h-2 rounded-full bg-sky-400 animate-pulse" />;
  }
  if (status === "saved") {
    return <span className="w-2 h-2 rounded-full bg-emerald-500" title="Saved" />;
  }
  if (status === "error") {
    return <span className="w-2 h-2 rounded-full bg-red-500" title="Error saving" />;
  }
  return <span className="w-2 h-2 rounded-full bg-slate-600" />;
}
