"use client";

import { useState } from "react";
import Link from "next/link";

function addDays(base: Date, n: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d;
}

function toISODate(d: Date): string {
  return d.toISOString().split("T")[0];
}

function formatDayLabel(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" });
}

type RowStatus = "saved" | "unsaved" | "saving" | "error";

interface DayRow {
  high_temp: string;
  low_temp: string;
  precip_chance: string;
  status: RowStatus;
  errorMsg: string;
}

interface Props {
  today: string;
  initialDays: { high_temp: number | null; low_temp: number | null; precip_chance: number | null }[];
}

export default function ForecastForm({ today, initialDays }: Props) {
  const todayDate = new Date(today + "T12:00:00");

  const [rows, setRows] = useState<DayRow[]>(() =>
    Array.from({ length: 7 }, (_, i) => {
      const d = initialDays[i];
      const hasData = d?.high_temp != null || d?.low_temp != null || d?.precip_chance != null;
      return {
        high_temp: d?.high_temp != null ? String(d.high_temp) : "",
        low_temp: d?.low_temp != null ? String(d.low_temp) : "",
        precip_chance: d?.precip_chance != null ? String(d.precip_chance) : "",
        status: hasData ? "saved" : "unsaved",
        errorMsg: "",
      };
    })
  );

  function updateField(i: number, field: "high_temp" | "low_temp" | "precip_chance", value: string) {
    setRows((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], [field]: value, status: "unsaved", errorMsg: "" };
      return next;
    });
  }

  async function saveRow(i: number) {
    const row = rows[i];
    if (row.high_temp === "" && row.low_temp === "" && row.precip_chance === "") return;

    setRows((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], status: "saving", errorMsg: "" };
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
        if (res.ok) {
          next[i] = { ...next[i], status: "saved", errorMsg: "" };
        } else {
          next[i] = { ...next[i], status: "error", errorMsg: json.error ?? "Save failed" };
        }
        return next;
      });
    } catch (err) {
      setRows((prev) => {
        const next = [...prev];
        next[i] = { ...next[i], status: "error", errorMsg: String(err) };
        return next;
      });
    }
  }

  const anySaved = rows.some((r) => r.status === "saved");

  return (
    <div className="space-y-5 max-w-xl">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">7-Day Forecast</h1>
          <p className="text-slate-400 text-sm mt-0.5">Philadelphia — edit a row and click Save</p>
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
        {/* Column headers */}
        <div className="grid grid-cols-[2fr_1fr_1fr_1fr_60px] px-4 py-2 border-b border-slate-700 text-xs font-semibold text-slate-500 uppercase tracking-wider">
          <div>Day</div>
          <div className="text-center">High °F</div>
          <div className="text-center">Low °F</div>
          <div className="text-center">Precip %</div>
          <div />
        </div>

        {rows.map((row, i) => {
          const date = addDays(todayDate, i);
          const label = i === 0 ? "Today" : i === 1 ? "Tomorrow" : formatDayLabel(date);

          return (
            <div key={i} className="border-b border-slate-700/50 last:border-0">
              <div className="grid grid-cols-[2fr_1fr_1fr_1fr_60px] items-center px-4 py-2 hover:bg-slate-700/20 transition-colors">
                {/* Label */}
                <div className="text-sm font-medium text-white">{label}</div>

                {/* High */}
                <div className="px-2">
                  <input
                    type="number"
                    value={row.high_temp}
                    placeholder="—"
                    onChange={(e) => updateField(i, "high_temp", e.target.value)}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-2 py-1.5 text-white text-sm text-center focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent placeholder:text-slate-600"
                  />
                </div>

                {/* Low */}
                <div className="px-2">
                  <input
                    type="number"
                    value={row.low_temp}
                    placeholder="—"
                    onChange={(e) => updateField(i, "low_temp", e.target.value)}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-2 py-1.5 text-white text-sm text-center focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent placeholder:text-slate-600"
                  />
                </div>

                {/* Precip */}
                <div className="px-2">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={row.precip_chance}
                    placeholder="—"
                    onChange={(e) => updateField(i, "precip_chance", e.target.value)}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-2 py-1.5 text-white text-sm text-center focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent placeholder:text-slate-600"
                  />
                </div>

                {/* Save button / status */}
                <div className="flex items-center justify-end pl-2">
                  {row.status === "saving" ? (
                    <span className="text-xs text-sky-400 animate-pulse">saving…</span>
                  ) : row.status === "saved" ? (
                    <span className="text-xs text-emerald-500">✓ saved</span>
                  ) : (
                    <button
                      onClick={() => saveRow(i)}
                      className="text-xs bg-sky-600 hover:bg-sky-500 text-white px-3 py-1.5 rounded-lg font-medium transition-colors"
                    >
                      Save
                    </button>
                  )}
                </div>
              </div>

              {/* Inline error */}
              {row.status === "error" && (
                <div className="px-4 pb-2 text-xs text-red-400">{row.errorMsg || "Save failed — check console"}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
