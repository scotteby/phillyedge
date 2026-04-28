import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

// Upsert a single forecast day: delete existing for (forecast_date, day_index) then insert.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { forecast_date, day_index, target_date, high_temp, low_temp, precip_chance, notes } = body;

    const supabase = createServiceClient();

    // Delete any existing row for this date + day slot
    await supabase
      .from("forecasts")
      .delete()
      .eq("forecast_date", forecast_date)
      .eq("day_index", day_index);

    const { error } = await supabase.from("forecasts").insert({
      forecast_date,
      day_index,
      target_date,
      high_temp: high_temp ?? 0,
      low_temp: low_temp ?? 0,
      precip_chance: precip_chance ?? 0,
      precip_type: "None",
      notes: notes ?? null,
    });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
