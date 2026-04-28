import { createServiceClient } from "@/lib/supabase/server";

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const CACHE_TTL_MINUTES = 30;

// Philadelphia weather series tickers (confirmed from kalshi.com URLs)
const PHILLY_SERIES = ["KXHIGHPHIL", "KXLOWTPHIL", "KXPRECIPPHIL"];

interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title: string;
  subtitle: string;
  yes_price_dollars: number; // 0-1 decimal (replaced yes_price cents on 2026-03-12)
  volume_fp: number;
  status: string;
  expiration_time: string;
}

function getYesPrice(m: KalshiMarket): number {
  return m.yes_price_dollars ?? 0.5;
}

function getEndDate(m: KalshiMarket): string {
  return m.expiration_time ? m.expiration_time.split("T")[0] : "";
}

function buildQuestion(m: KalshiMarket): string {
  return m.title || m.subtitle || m.ticker;
}

export interface FetchMarketsResult {
  data: Record<string, unknown>[] | null;
  fromCache: boolean;
  lastUpdated: string | null;
  rawCount: number;
}

export async function fetchAndCacheMarkets(): Promise<FetchMarketsResult> {
  const supabase = createServiceClient();

  // Check cache freshness
  const { data: cached } = await supabase
    .from("market_cache")
    .select("fetched_at")
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

  // Fetch all 3 Philadelphia series in parallel
  let phillyMarkets: KalshiMarket[] = [];
  let rawCount = 0;

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
      phillyMarkets = phillyMarkets.concat(markets);
    }

    // Fallback: if series returned nothing, scan open markets and filter by city name
    if (phillyMarkets.length === 0) {
      console.log("[kalshi] Series fetch returned 0 markets — trying open market scan fallback");

      const fallbackRes = await fetch(
        `${KALSHI_BASE}/markets?status=open&limit=200`,
        { headers: { Accept: "application/json" }, cache: "no-store" }
      );

      if (fallbackRes.ok) {
        const fallbackJson = await fallbackRes.json();
        const allMarkets: KalshiMarket[] = fallbackJson.markets ?? [];
        rawCount += allMarkets.length;

        console.log(`[kalshi] Fallback: ${allMarkets.length} open markets total`);
        console.log("[kalshi] Sample titles:", allMarkets.slice(0, 10).map((m) => m.title));

        // Match Philadelphia weather markets only — not sports (Eagles, Phillies, 76ers etc.)
        const WEATHER_KW = ["temperature", "temp", "precip", "rain", "snow", "high", "low"];
        phillyMarkets = allMarkets.filter((m) => {
          const ticker = (m.ticker ?? "").toLowerCase();
          const title = (m.title ?? "").toLowerCase();
          const isPhilly = ticker.includes("phil") || title.includes("philadelphia") || title.includes("philly");
          const isWeather = WEATHER_KW.some((k) => title.includes(k)) || ticker.startsWith("kxhigh") || ticker.startsWith("kxlowt") || ticker.startsWith("kxprecip");
          return isPhilly && isWeather;
        });

        console.log(`[kalshi] Fallback matched ${phillyMarkets.length} Philly markets:`, phillyMarkets.map((m) => m.ticker));
      }
    }
  } catch (err) {
    console.error("[kalshi] Fetch error:", err);
    // Fall through to stale cache
  }

  const fetchedAt = new Date().toISOString();

  if (phillyMarkets.length > 0) {
    // Mark old records inactive
    await supabase
      .from("market_cache")
      .update({ active: false })
      .neq("id", "00000000-0000-0000-0000-000000000000");

    const rows = phillyMarkets.map((m) => ({
      fetched_at: fetchedAt,
      market_id: m.ticker,
      question: buildQuestion(m),
      end_date: getEndDate(m),
      yes_price: getYesPrice(m),
      volume: m.volume_fp ?? 0,
      active: true,
    }));

    await supabase.from("market_cache").insert(rows);
  }

  const { data } = await supabase
    .from("market_cache")
    .select("*")
    .eq("active", true)
    .order("volume", { ascending: false });

  return { data, fromCache: false, lastUpdated: fetchedAt, rawCount };
}
