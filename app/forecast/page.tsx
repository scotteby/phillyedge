import { createServiceClient } from "@/lib/supabase/server";
import ForecastForm from "./ForecastForm";
import type { Forecast } from "@/lib/types";

export const dynamic = "force-dynamic";

function toISODate(d: Date): string {
  return d.toISOString().split("T")[0];
}

export default async function ForecastPage() {
  const today = toISODate(new Date());
  const supabase = createServiceClient();

  // Load today's existing forecast if any
  const { data } = await supabase
    .from("forecasts")
    .select("*")
    .eq("forecast_date", today)
    .order("day_index", { ascending: true });

  const existing = (data as Forecast[] | null) ?? [];

  const lastSaved =
    existing.length > 0
      ? new Date(existing[0].created_at).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : null;

  const initialDays =
    existing.length === 7
      ? existing.map((f) => ({
          high_temp: f.high_temp,
          low_temp: f.low_temp,
          precip_chance: f.precip_chance,
          precip_type: f.precip_type,
          target_date: f.target_date,
        }))
      : undefined;

  return <ForecastForm lastSaved={lastSaved} initialDays={initialDays} />;
}
