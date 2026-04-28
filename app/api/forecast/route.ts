import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { days, notes, forecast_date } = body as {
      days: {
        day_index: number;
        target_date: string;
        high_temp: number;
        low_temp: number;
        precip_chance: number;
        precip_type: string;
      }[];
      notes: string;
      forecast_date: string;
    };

    const supabase = createServiceClient();

    const rows = days.map((d) => ({
      forecast_date,
      day_index: d.day_index,
      target_date: d.target_date,
      high_temp: d.high_temp,
      low_temp: d.low_temp,
      precip_chance: d.precip_chance,
      precip_type: d.precip_type,
      notes: d.day_index === 0 ? (notes || null) : null,
    }));

    const { error } = await supabase.from("forecasts").insert(rows);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const date = searchParams.get("date");

  const supabase = createServiceClient();

  let query = supabase
    .from("forecasts")
    .select("*")
    .order("target_date", { ascending: true });

  if (date) {
    query = query.eq("forecast_date", date);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data });
}
