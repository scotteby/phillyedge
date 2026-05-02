import { createServiceClient } from "@/lib/supabase/server";
import { easternToday } from "@/lib/dates";
import ForecastForm from "./ForecastForm";
import type { Forecast } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ForecastPage() {
  const today = easternToday();
  const supabase = createServiceClient();

  // Compute the 7 target dates (today through today+6) in Eastern time.
  // We query by target_date rather than forecast_date so that yesterday's
  // forecast entries still populate the form today (the user shouldn't have
  // to re-enter everything from scratch each morning).
  const todayMs = new Date(today + "T12:00:00").getTime();
  const targetDates = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(todayMs + i * 86_400_000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });

  const { data } = await supabase
    .from("forecasts")
    .select("*")
    .in("target_date", targetDates)
    .order("created_at", { ascending: false }); // most-recent first

  const existing = (data as Forecast[] | null) ?? [];

  // Build a 7-slot array — for each target date, use the most recent forecast.
  const initialDays = Array.from({ length: 7 }, (_, i) => {
    const td  = targetDates[i];
    const row = existing.find((f) => f.target_date === td);
    return {
      high_temp:           row?.high_temp           ?? null,
      low_temp:            row?.low_temp            ?? null,
      precip_chance:       row?.precip_chance       ?? null,
      precip_type:         row?.precip_type         ?? null,
      forecast_confidence: row?.forecast_confidence ?? null,
    };
  });

  return <ForecastForm today={today} initialDays={initialDays} />;
}
