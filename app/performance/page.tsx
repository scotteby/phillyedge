import { createServiceClient } from "@/lib/supabase/server";
import PerformanceClient, {
  type ForecastResultDB,
  type RecommendationResultDB,
  type RecLogDB,
} from "./PerformanceClient";

export const dynamic = "force-dynamic";

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Yesterday's date in ET as YYYY-MM-DD — default date for manual settlement. */
function yesterdayET(): string {
  const nowET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  nowET.setDate(nowET.getDate() - 1);
  return `${nowET.getFullYear()}-${String(nowET.getMonth() + 1).padStart(2, "0")}-${String(nowET.getDate()).padStart(2, "0")}`;
}

export default async function PerformancePage() {
  const supabase = createServiceClient();
  const since = isoDaysAgo(90);

  const [{ data: fr }, { data: rr }, { data: rl }, { data: lastRow }] = await Promise.all([
    supabase
      .from("forecast_results")
      .select("*")
      .gte("forecast_date", since)
      .order("forecast_date", { ascending: false }),
    supabase
      .from("recommendation_results")
      .select("*")
      .gte("forecast_date", since)
      .order("forecast_date", { ascending: false }),
    supabase
      .from("recommendation_log")
      .select("*")
      .gte("target_date", since)
      .order("generated_at", { ascending: false }),
    supabase
      .from("forecast_results")
      .select("created_at, forecast_date")
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  const lastSettledAt   = (lastRow?.[0] as { created_at: string } | undefined)?.created_at ?? null;
  const lastSettledDate = (lastRow?.[0] as { forecast_date: string } | undefined)?.forecast_date ?? null;

  return (
    <PerformanceClient
      forecastResults={(fr as ForecastResultDB[] | null) ?? []}
      recResults={(rr as RecommendationResultDB[] | null) ?? []}
      recLog={(rl as RecLogDB[] | null) ?? []}
      lastSettledAt={lastSettledAt}
      lastSettledDate={lastSettledDate}
      defaultSettlementDate={yesterdayET()}
    />
  );
}
