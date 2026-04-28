import { createServiceClient } from "@/lib/supabase/server";
import type { Trade } from "@/lib/types";
import HistoryClient from "./HistoryClient";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const supabase = createServiceClient();

  const { data } = await supabase
    .from("trades")
    .select("*")
    .order("created_at", { ascending: false });

  const trades = (data as Trade[] | null) ?? [];

  return <HistoryClient initialTrades={trades} />;
}
