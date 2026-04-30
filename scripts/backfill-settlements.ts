/**
 * Backfill historical settlement results.
 *
 * Usage:
 *   npx tsx scripts/backfill-settlements.ts --start=2026-01-01 --end=2026-04-29
 *
 * Loops over each date in [start, end] inclusive, calls the daily-settlement
 * logic, and logs results. Safe to re-run — upserts.
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in env.
 */

import { createClient } from "@supabase/supabase-js";
import {
  buildForecastResultRows,
  buildRecommendationResultRow,
  fetchActualWeather,
} from "../lib/settlement";
import type { Forecast, Trade } from "../lib/types";

interface Args {
  start: string;
  end:   string;
}

function parseArgs(): Args {
  const args: Args = { start: "", end: "" };
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--(start|end)=(.+)$/);
    if (m) (args as unknown as Record<string, string>)[m[1]] = m[2];
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.start) || !/^\d{4}-\d{2}-\d{2}$/.test(args.end)) {
    console.error("Usage: npx tsx scripts/backfill-settlements.ts --start=YYYY-MM-DD --end=YYYY-MM-DD");
    process.exit(1);
  }
  return args;
}

function* dateRange(start: string, end: string): Generator<string> {
  const [y0, m0, d0] = start.split("-").map(Number);
  const [y1, m1, d1] = end.split("-").map(Number);
  const cur  = new Date(Date.UTC(y0, m0 - 1, d0));
  const stop = new Date(Date.UTC(y1, m1 - 1, d1));
  while (cur <= stop) {
    yield `${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, "0")}-${String(cur.getUTCDate()).padStart(2, "0")}`;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
}

interface Row { date: string; forecastRows: number; recRows: number; status: string }

async function main(): Promise<void> {
  const { start, end } = parseArgs();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  const supabase = createClient(url, key);

  const summary: Row[] = [];

  for (const date of dateRange(start, end)) {
    process.stdout.write(`[${date}] `);
    try {
      const actuals = await fetchActualWeather(date);

      const { data: fRows } = await supabase
        .from("forecasts")
        .select("*")
        .eq("target_date", date)
        .order("created_at", { ascending: false })
        .limit(1);
      const forecast = (fRows?.[0] as Forecast | undefined) ?? null;

      let forecastWritten = 0;
      if (forecast) {
        const rows = buildForecastResultRows(forecast, actuals);
        const { error } = await supabase
          .from("forecast_results")
          .upsert(rows, { onConflict: "forecast_date,metric" });
        if (error) throw new Error(`forecast_results upsert: ${error.message}`);
        forecastWritten = rows.length;
      }

      const { data: tRows } = await supabase
        .from("trades")
        .select("*")
        .eq("target_date", date)
        .in("outcome", ["win", "loss"]);
      const trades = (tRows as Trade[] | null) ?? [];

      let recsWritten = 0;
      if (trades.length > 0) {
        const rows = trades.map((t) => buildRecommendationResultRow(t, actuals));
        const { error } = await supabase
          .from("recommendation_results")
          .upsert(rows, { onConflict: "trade_id" });
        if (error) throw new Error(`recommendation_results upsert: ${error.message}`);
        recsWritten = rows.length;
      }

      const status =
        forecastWritten === 0 && recsWritten === 0 ? "skipped (no data)" : "ok";
      console.log(`forecast=${forecastWritten} rec=${recsWritten} ${status}`);
      summary.push({ date, forecastRows: forecastWritten, recRows: recsWritten, status });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`ERROR — ${msg}`);
      summary.push({ date, forecastRows: 0, recRows: 0, status: `error: ${msg}` });
    }
  }

  console.log("\n──────── Summary ────────");
  console.log(`Range: ${start} → ${end}  (${summary.length} days)`);
  const ok      = summary.filter((s) => s.status === "ok").length;
  const skipped = summary.filter((s) => s.status.startsWith("skipped")).length;
  const errored = summary.filter((s) => s.status.startsWith("error")).length;
  console.log(`OK: ${ok}  Skipped: ${skipped}  Errored: ${errored}`);
  console.log(`Forecast rows written:       ${summary.reduce((s, r) => s + r.forecastRows, 0)}`);
  console.log(`Recommendation rows written: ${summary.reduce((s, r) => s + r.recRows, 0)}`);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
