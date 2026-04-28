"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ForecastDayInput } from "@/lib/types";

function addDays(base: Date, n: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d;
}

function toISODate(d: Date): string {
  return d.toISOString().split("T")[0];
}

function formatDayLabel(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

const DAY_LABELS = ["Today", "Tomorrow", "Day 3", "Day 4", "Day 5", "Day 6", "Day 7"];

const DEFAULT_DAY: ForecastDayInput = {
  high_temp: "",
  low_temp: "",
  precip_chance: "",
  precip_type: "None",
};

interface Props {
  lastSaved: string | null;
  initialDays?: (ForecastDayInput & { target_date?: string })[];
}

export default function ForecastForm({ lastSaved, initialDays }: Props) {
  const router = useRouter();
  const today = new Date();

  const [days, setDays] = useState<ForecastDayInput[]>(
    initialDays
      ? initialDays.map((d) => ({
          high_temp: d.high_temp,
          low_temp: d.low_temp,
          precip_chance: d.precip_chance,
          precip_type: d.precip_type,
        }))
      : Array.from({ length: 7 }, () => ({ ...DEFAULT_DAY }))
  );
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateDay(i: number, field: keyof ForecastDayInput, value: string) {
    setDays((prev) => {
      const next = [...prev];
      if (field === "precip_type") {
        next[i] = { ...next[i], precip_type: value as ForecastDayInput["precip_type"] };
      } else {
        next[i] = { ...next[i], [field]: value === "" ? "" : Number(value) };
      }
      return next;
    });
  }

  async function handleSave() {
    // Validate all days have required fields
    for (let i = 0; i < days.length; i++) {
      const d = days[i];
      if (d.high_temp === "" || d.low_temp === "" || d.precip_chance === "") {
        setError(`Day ${i + 1} is incomplete. Please fill in all fields.`);
        return;
      }
    }

    setSaving(true);
    setError(null);

    const forecast_date = toISODate(today);
    const payload = {
      forecast_date,
      notes,
      days: days.map((d, i) => ({
        day_index: i,
        target_date: toISODate(addDays(today, i)),
        high_temp: Number(d.high_temp),
        low_temp: Number(d.low_temp),
        precip_chance: Number(d.precip_chance),
        precip_type: d.precip_type,
      })),
    };

    try {
      const res = await fetch("/api/forecast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      router.push("/markets");
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">7-Day Forecast</h1>
          <p className="text-slate-400 text-sm mt-0.5">Philadelphia region — enter your forecast for each day</p>
        </div>
        {lastSaved && (
          <span className="text-xs text-slate-500 bg-slate-800 px-3 py-1 rounded-full">
            Last saved: {lastSaved}
          </span>
        )}
      </div>

      {/* Grid header */}
      <div className="hidden md:grid md:grid-cols-[1fr_100px_100px_110px_130px] gap-3 px-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">
        <div>Day</div>
        <div>High (°F)</div>
        <div>Low (°F)</div>
        <div>Precip %</div>
        <div>Type</div>
      </div>

      {/* Day rows */}
      {days.map((day, i) => {
        const date = addDays(today, i);
        return (
          <div
            key={i}
            className="bg-slate-800 border border-slate-700 rounded-xl p-4 grid md:grid-cols-[1fr_100px_100px_110px_130px] gap-3 items-center"
          >
            {/* Day label */}
            <div>
              <span className="font-semibold text-white">
                {i < 2 ? DAY_LABELS[i] : formatDayLabel(date)}
              </span>
              {i < 2 && (
                <span className="text-slate-400 text-sm ml-2">{formatDayLabel(date)}</span>
              )}
            </div>

            {/* High temp */}
            <div>
              <label className="block text-xs text-slate-500 mb-1 md:hidden">High (°F)</label>
              <input
                type="number"
                value={day.high_temp}
                onChange={(e) => updateDay(i, "high_temp", e.target.value)}
                placeholder="75"
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent"
              />
            </div>

            {/* Low temp */}
            <div>
              <label className="block text-xs text-slate-500 mb-1 md:hidden">Low (°F)</label>
              <input
                type="number"
                value={day.low_temp}
                onChange={(e) => updateDay(i, "low_temp", e.target.value)}
                placeholder="55"
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent"
              />
            </div>

            {/* Precip chance */}
            <div>
              <label className="block text-xs text-slate-500 mb-1 md:hidden">Precip %</label>
              <div className="relative">
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={day.precip_chance}
                  onChange={(e) => updateDay(i, "precip_chance", e.target.value)}
                  placeholder="30"
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 pr-7 text-white text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent"
                />
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs">%</span>
              </div>
            </div>

            {/* Precip type */}
            <div>
              <label className="block text-xs text-slate-500 mb-1 md:hidden">Type</label>
              <select
                value={day.precip_type}
                onChange={(e) => updateDay(i, "precip_type", e.target.value)}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent"
              >
                <option value="None">None</option>
                <option value="Rain">Rain</option>
                <option value="Snow">Snow</option>
                <option value="Mix">Mix</option>
              </select>
            </div>
          </div>
        );
      })}

      {/* Notes */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 space-y-2">
        <label className="block text-sm font-medium text-slate-300">Forecaster Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="Any pattern notes, model disagreements, confidence levels..."
          className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm resize-none focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent placeholder:text-slate-500"
        />
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Footer CTA */}
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className="bg-sky-500 hover:bg-sky-400 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-semibold px-6 py-2.5 rounded-xl transition-colors text-sm"
        >
          {saving ? "Saving..." : "Save & View Markets →"}
        </button>
      </div>
    </div>
  );
}
