import { NextRequest, NextResponse } from "next/server";
import { fetchAndCacheMarkets } from "@/lib/kalshi";
import { createServiceClient } from "@/lib/supabase/server";

export async function GET(req: NextRequest) {
  try {
    // ?bust=true clears stale cache rows before fetching
    const bust = new URL(req.url).searchParams.get("bust") === "true";
    if (bust) {
      const supabase = createServiceClient();
      await supabase
        .from("market_cache")
        .update({ active: false })
        .neq("id", "00000000-0000-0000-0000-000000000000");
    }

    const result = await fetchAndCacheMarkets();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
