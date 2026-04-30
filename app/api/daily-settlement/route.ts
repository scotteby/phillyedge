import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import {
  buildForecastResultRows,
  buildRecommendationResultRow,
  fetchActualWeather,
  settleRecommendationLog,
  type ForecastResultRow,
  type RecommendationResultRow,
  type SettlementSummary,
} from "@/lib/settlement";
import type { Forecast, Trade } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Yesterday's date in ET as YYYY-MM-DD. */
function yesterdayET(): string {
  const nowET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  nowET.setDate(nowET.getDate() - 1);
  return `${nowET.getFullYear()}-${String(nowET.getMonth() + 1).padStart(2, "0")}-${String(nowET.getDate()).padStart(2, "0")}`;
}

async function settle(date: string): Promise<SettlementSummary> {
  const supabase = createServiceClient();
  const skipped: string[] = [];
  const errors:  string[] = [];

  // 1. Pull actual weather first — if NWS fails we abort cleanly.
  let actuals;
  try {
    actuals = await fetchActualWeather(date);
  } catch (err) {
    return {
      settled_date:        date,
      forecast_rows:       0,
      recommendation_rows: 0,
      rec_log_rows:        0,
      skipped:             [],
      errors:              [`fetchActualWeather failed: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  // 2. Most-recent forecast row for this target_date
  const { data: forecastRows, error: fErr } = await supabase
    .from("forecasts")
    .select("*")
    .eq("target_date", date)
    .order("created_at", { ascending: false })
    .limit(1);

  if (fErr) errors.push(`forecasts query: ${fErr.message}`);

  let forecastWritten = 0;
  const forecast = (forecastRows?.[0] as Forecast | undefined) ?? null;

  if (!forecast) {
    skipped.push(`no forecast row for ${date}`);
  } else {
    const rows: ForecastResultRow[] = buildForecastResultRows(forecast, actuals);
    const { error: upErr } = await supabase
      .from("forecast_results")
      .upsert(rows, { onConflict: "forecast_date,metric" });
    if (upErr) errors.push(`forecast_results upsert: ${upErr.message}`);
    else forecastWritten = rows.length;
  }

  // 3. Settled trades for this target_date (win or loss only)
  const { data: tradeRows, error: tErr } = await supabase
    .from("trades")
    .select("*")
    .eq("target_date", date)
    .in("outcome", ["win", "loss"]);

  if (tErr) errors.push(`trades query: ${tErr.message}`);

  let recsWritten = 0;
  const trades = (tradeRows as Trade[] | null) ?? [];

  if (trades.length === 0) {
    skipped.push(`no settled trades for ${date}`);
  } else {
    const rows: RecommendationResultRow[] = trades.map((t) =>
      buildRecommendationResultRow(t, actuals),
    );
    const { error: upErr } = await supabase
      .from("recommendation_results")
      .upsert(rows, { onConflict: "trade_id" });
    if (upErr) errors.push(`recommendation_results upsert: ${upErr.message}`);
    else recsWritten = rows.length;
  }

  // 4. Phase 2.5: settle recommendation_log rows for this date.
  const recLogResult = await settleRecommendationLog(date, actuals, supabase);
  if (recLogResult.errors.length > 0) {
    errors.push(...recLogResult.errors.map((e) => `rec_log: ${e}`));
  }

  return {
    settled_date:        date,
    forecast_rows:       forecastWritten,
    recommendation_rows: recsWritten,
    rec_log_rows:        recLogResult.settled,
    skipped,
    errors,
  };
}

async function run(date: string) {
  const summary = await settle(date);
  const status  = summary.errors.length === 0 ? 200 : 207; // partial success
  return NextResponse.json(summary, { status });
}

// Vercel cron uses GET; manual triggers can use POST with a JSON body.
export async function GET(req: NextRequest) {
  const dateParam = req.nextUrl.searchParams.get("date");
  return run(dateParam ?? yesterdayET());
}

export async function POST(req: NextRequest) {
  let body: { date?: string } = {};
  try { body = await req.json(); } catch { /* empty body OK */ }
  return run(body.date ?? yesterdayET());
}
