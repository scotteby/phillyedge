import { createServiceClient } from "@/lib/supabase/server";

const KALSHI_BASE = "https://api.kalshi.com/trade-api/v2";
const CACHE_TTL_MINUTES = 30;

// Kalshi event tickers for Philadelphia weather markets
const PHILLY_EVENT_KEYWORDS = ["hightemp", "lowtemp", "weather", "precip", "rain", "snow"];
const PHILLY_SUBTITLE_KEYWORDS = ["philadelphia", "philly"];

interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title: string;
  subtitle: string;
  yes_bid: number;
  yes_ask: number;
  last_price: number;
  volume: number;
  open_interest: number;
  status: string;
  close_time: string;
  expiration_time: string;
  result: string;
}

function isPhillyWeatherMarket(m: KalshiMarket): boolean {
  const eventTicker = m.event_ticker.toLowerCase();
  const subtitle = (m.subtitle ?? "").toLowerCase();
  const title = (m.title ?? "").toLowerCase();

  const isWeather = PHILLY_EVENT_KEYWORDS.some((k) => eventTicker.includes(k));
  const isPhilly =
    PHILLY_SUBTITLE_KEYWORDS.some((k) => subtitle.includes(k)) ||
    PHILLY_SUBTITLE_KEYWORDS.some((k) => title.includes(k));

  return isWeather && isPhilly;
}

function getYesPrice(m: KalshiMarket): number {
  // Use midpoint of bid/ask; fall back to last_price, then 0.5
  if (m.yes_bid > 0 && m.yes_ask > 0) {
    return (m.yes_bid + m.yes_ask) / 2;
  }
  if (m.last_price > 0) return m.last_price;
  return 0.5;
}

function getEndDate(m: KalshiMarket): string {
  const ts = m.close_time ?? m.expiration_time ?? "";
  return ts ? ts.split("T")[0] : "";
}

// Build the Polymarket-compatible question string from Kalshi fields
function buildQuestion(m: KalshiMarket): string {
  if (m.subtitle) return m.subtitle;
  if (m.title) return m.title;
  return m.ticker;
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

  // Fetch from Kalshi — paginate through open markets
  let phillyMarkets: KalshiMarket[] = [];
  let cursor: string | null = null;
  let pagesScanned = 0;
  let rawCount = 0;
  const MAX_PAGES = 30;

  try {
    do {
      const params = new URLSearchParams({
        status: "open",
        limit: "200",
      });
      if (cursor) params.set("cursor", cursor);

      const res = await fetch(`${KALSHI_BASE}/markets?${params}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });

      if (!res.ok) break;

      const json = await res.json();
      const markets: KalshiMarket[] = json.markets ?? [];
      rawCount += markets.length;

      const philly = markets.filter(
        (m) => m.status === "open" && isPhillyWeatherMarket(m)
      );
      phillyMarkets = phillyMarkets.concat(philly);

      cursor = json.cursor ?? null;
      pagesScanned++;
    } while (cursor && pagesScanned < MAX_PAGES);
  } catch {
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
      volume: m.volume ?? 0,
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
