import { redirect } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import { easternToday } from "@/lib/dates";

export const dynamic = "force-dynamic";

export default async function RootPage() {
  const supabase = createServiceClient();
  const today = easternToday();

  const { data } = await supabase
    .from("forecasts")
    .select("id")
    .eq("forecast_date", today)
    .limit(1);

  const hasForecast = data && data.length > 0;

  redirect(hasForecast ? "/markets" : "/forecast");
}
