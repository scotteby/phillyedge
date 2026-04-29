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

  const { data } = await supabase
    .from("forecasts")
    .select("*")
    .eq("forecast_date", today)
    .order("day_index", { ascending: true });

  const existing = (data as Forecast[] | null) ?? [];

  // Build a 7-slot array, sparse where no data yet
  const initialDays = Array.from({ length: 7 }, (_, i) => {
    const row = existing.find((f) => f.day_index === i);
    return {
      high_temp: row?.high_temp ?? null,
      low_temp: row?.low_temp ?? null,
      precip_chance: row?.precip_chance ?? null,
      precip_type: row?.precip_type ?? null,
    };
  });

  return <ForecastForm today={today} initialDays={initialDays} />;
}
