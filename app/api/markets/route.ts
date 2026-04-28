import { NextResponse } from "next/server";
import { fetchAndCacheMarkets } from "@/lib/kalshi";

export async function GET() {
  try {
    const result = await fetchAndCacheMarkets();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
