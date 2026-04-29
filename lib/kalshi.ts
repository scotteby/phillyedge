import { createServiceClient } from "@/lib/supabase/server";

const DEMO_MODE   = process.env.KALSHI_DEMO_MODE === "true";
const KALSHI_BASE = DEMO_MODE
  ? "https://demo-api.kalshi.co/trade-api/v2"
  : "https://api.elections.kalshi.com/trade-api/v2";
const CACHE_TTL_MINUTES = 30;

// Philadelphia weather series tickers (confirmed from kalshi.com URLs)
const PHILLY_SERIES = ["KXHIGHPHIL", "KXLOWTPHIL", "KXPRECIPPHIL"];

interface KalshiMarket {
  ticker:               string;
  event_ticker:         string;
  title:                string;
  yes_bid_dollars:      string;
  yes_ask_dollars:      string;
  last_price_dollars:   string;
  volume_fp:            number;
  status:               string;
  occurrence_datetime:  string; // the actual weather date
  strike_type:          string; // "greater" | "less" | "between"
}

function getYesPrice(m: KalshiMarket): number {
  const bid  = parseFloat(m.yes_bid_dollars  ?? "0");
  const ask  = parseFloat(m.yes_ask_dollars  ?? "0");
  if (bid > 0 && ask > 0) return (bid + ask) / 2;
  const last = parseFloat(m.last_price_dollars ?? "0");
  return last > 0 ? last : 0.5;
}

function getEndDate(m: KalshiMarket): string {
  return m.occurrence_datetime ? m.occurrence_datetime.split("T")[0] : "";
}

export interface FetchMarketsResult {
  data:         Record<string, unknown>[] | null;
  fromCache:    boolean;
  lastUpdated:  string | null;
  rawCount:     number;
}

export async function fetchAndCacheMarkets(): Promise<FetchMarketsResult> {
  const supabase = createServiceClient();

  // ── Cache freshness check ──────────────────────────────────────────────────
  const { data: cached } = await supabase
    .from("market_cache")
    .select("fetched_at")
    .eq("active", true)
    .order("fetched_at", { ascending: false })
    .limit(1);

  if (cached && cached.length > 0) {
    const age = Date.now() - new Date(cached[0].fetched_at).getTime();
    if (age < CACHE_TTL_MINUTES * 60 * 1000) {
      const { data } = await supabase
        .from("market_cache")
        .select("*")
        .eq("active", true)
        .order("volume", { ascending: false });
      return { data, fromCache: true, lastUpdated: cached[0].fetched_at, rawCount: 0 };
    }
  }

  // ── Fetch all Philadelphia series in parallel ──────────────────────────────
  const seen        = new Set<string>();
  let allMarkets:   KalshiMarket[] = [];
  let rawCount      = 0;

  try {
    const results = await Promise.all(
      PHILLY_SERIES.map((series) =>
        fetch(
          `${KALSHI_BASE}/markets?series_ticker=${series}&status=open`,
          { headers: { Accept: "application/json" }, cache: "no-store" }
        ).then((r) => (r.ok ? r.json() : { markets: [] }))
      )
    );

    for (const json of results) {
      const markets: KalshiMarket[] = json.markets ?? [];
      rawCount += markets.length;

      // Include ALL strike types (greater / less / between) — we need every
      // bracket row. Deduplicate by ticker in case of overlapping responses.
      for (const m of markets) {
        if (!seen.has(m.ticker)) {
          seen.add(m.ticker);
          allMarkets.push(m);
        }
      }
    }

    console.log(
      "[kalshi] Fetched tickers:",
      allMarkets.map((m) => m.ticker).join(", ") || "(none)"
    );

    // ── Fallback: scan open markets if series returned nothing ───────────────
    if (allMarkets.length === 0) {
      console.log("[kalshi] Series fetch returned 0 markets — trying fallback scan");
      const fallbackRes = await fetch(
        `${KALSHI_BASE}/markets?status=open&limit=200`,
        { headers: { Accept: "application/json" }, cache: "no-store" }
      );
      if (fallbackRes.ok) {
        const fb  = await fallbackRes.json();
        const all: KalshiMarket[] = fb.markets ?? [];
        rawCount += all.length;

        for (const m of all) {
          const t = m.ticker.toLowerCase();
          const isPhillyWeather =
            (t.startsWith("kxhigh") || t.startsWith("kxlowt") || t.startsWith("kxprecip")) &&
            t.includes("phil");
          if (isPhillyWeather && !seen.has(m.ticker)) {
            seen.add(m.ticker);
            allMarkets.push(m);
          }
        }
        console.log("[kalshi] Fallback tickers:", allMarkets.map((m) => m.ticker).join(", ") || "(none)");
      }
    }
  } catch (err) {
    console.error("[kalshi] Fetch error:", err);
  }

  const fetchedAt = new Date().toISOString();

  if (allMarkets.length > 0) {
    // Wipe stale cache and insert fresh rows
    await supabase
      .from("market_cache")
      .delete()
      .neq("id", "00000000-0000-0000-0000-000000000000");

    const rows = allMarkets.map((m) => ({
      fetched_at: fetchedAt,
      market_id:  m.ticker,
      question:   m.title.replace(/\*\*/g, ""), // strip Kalshi markdown bold
      end_date:   getEndDate(m),
      yes_price:  getYesPrice(m),
      volume:     parseFloat(String(m.volume_fp)) || 0,
      active:     true,
    }));

    await supabase.from("market_cache").insert(rows);
  } else {
    // Kalshi returned nothing — reactivate whatever was in the cache so the
    // page doesn't go blank. This handles the bust=true → Kalshi 0-result case.
    console.log("[kalshi] 0 markets from Kalshi — reactivating existing cache rows");
    await supabase
      .from("market_cache")
      .update({ active: true })
      .neq("id", "00000000-0000-0000-0000-000000000000");
  }

  const { data } = await supabase
    .from("market_cache")
    .select("*")
    .eq("active", true)
    .order("volume", { ascending: false });

  return { data, fromCache: false, lastUpdated: fetchedAt, rawCount };
}
