/**
 * GET /api/balance
 *
 * Returns the authenticated user's available Kalshi portfolio balance.
 * Endpoint: GET /trade-api/v2/portfolio/balance
 * Kalshi returns balance in cents (integer).
 */

import { NextRequest, NextResponse } from "next/server";
import { buildKalshiAuthHeaders } from "@/lib/kalshi-sign";

const DEMO_MODE       = process.env.KALSHI_DEMO_MODE === "true";
const PROD_BASE       = "https://api.elections.kalshi.com/trade-api/v2";
const DEMO_BASE_URL   = "https://demo-api.kalshi.co/trade-api/v2";
const BALANCE_PATH    = "/trade-api/v2/portfolio/balance";

export async function GET(req: NextRequest) {
  // ?demo=true forces demo credentials regardless of KALSHI_DEMO_MODE env var.
  const forceDemo  = req.nextUrl.searchParams.get("demo") === "true";
  const useDemo    = forceDemo || DEMO_MODE;
  const KALSHI_BASE = useDemo ? DEMO_BASE_URL : PROD_BASE;

  let headers: Record<string, string>;
  try {
    headers = buildKalshiAuthHeaders("GET", BALANCE_PATH, useDemo || undefined);
  } catch (err) {
    return NextResponse.json(
      { error: `Signing error: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }

  try {
    const res = await fetch(`${KALSHI_BASE}/portfolio/balance`, {
      method: "GET",
      headers,
      cache:  "no-store",
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.warn("[balance] Kalshi error:", res.status, JSON.stringify(body));
      return NextResponse.json(
        { error: `Kalshi ${res.status}` },
        { status: 502 }
      );
    }

    const json = await res.json();
    console.log("[balance] raw response:", JSON.stringify(json));

    // Kalshi returns balance in cents as an integer.
    // Field may be `balance` or inside a nested object.
    const raw = json.balance ?? json.portfolio?.balance ?? null;
    const balanceCents   = raw != null ? Number(raw) : null;
    const balanceDollars = balanceCents != null ? balanceCents / 100 : null;

    return NextResponse.json({ balance_cents: balanceCents, balance_dollars: balanceDollars });
  } catch (err) {
    return NextResponse.json(
      { error: `Network error: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    );
  }
}
