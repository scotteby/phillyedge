import { createServiceClient } from "@/lib/supabase/server";
import PerformanceClient, {
  type ForecastResultDB,
  type RecommendationResultDB,
} from "./PerformanceClient";

export const dynamic = "force-dynamic";

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default async function PerformancePage() {
  const supabase = createServiceClient();
  const since = isoDaysAgo(90);

  const [{ data: fr }, { data: rr }] = await Promise.all([
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
  ]);

  return (
    <PerformanceClient
      forecastResults={(fr as ForecastResultDB[] | null) ?? []}
      recResults={(rr as RecommendationResultDB[] | null) ?? []}
    />
  );
}
