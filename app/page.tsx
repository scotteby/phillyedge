import { redirect } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function toISODate(d: Date): string {
  return d.toISOString().split("T")[0];
}

export default async function RootPage() {
  const supabase = createServiceClient();
  const today = toISODate(new Date());

  const { data } = await supabase
    .from("forecasts")
    .select("id")
    .eq("forecast_date", today)
    .limit(1);

  const hasForecast = data && data.length > 0;

  redirect(hasForecast ? "/markets" : "/forecast");
}
