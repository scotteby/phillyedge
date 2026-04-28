import { createServiceClient } from "@/lib/supabase/server";

const POLYMARKET_BASE = "https://clob.polymarket.com";
const CACHE_TTL_MINUTES = 30;

// Cast wide — Polymarket uses various phrasings
const PHILLY_KEYWORDS = ["philadelphia", "philly", " phl ", "phl,", "phl."];

export interface PolymarketToken {
  token_id: string;
  outcome: string;
  price: string;
}

export interface PolymarketMarket {
  condition_id: string;
  question: string;
  end_date_iso: string;
  tokens: PolymarketToken[];
  volume: string | number;
  active: boolean;
  closed: boolean;
  market_slug?: string;
}

export function isPhillyMarket(question: string): boolean {
  const q = ` ${question.toLowerCase()} `;
  return PHILLY_KEYWORDS.some((kw) => q.includes(kw));
}

export function getYesPrice(tokens: PolymarketToken[]): number {
  const yes = tokens.find((t) => t.outcome.toLowerCase() === "yes");
  return yes ? parseFloat(yes.price) : 0.5;
}

export interface FetchMarketsResult {
  data: Record<string, unknown>[] | null;
  fromCache: boolean;
  lastUpdated: string | null;
  rawCount: number; // total markets seen before filtering (debug)
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

  // Fetch from Polymarket — paginate until we've scanned enough or run out
  let phillyMarkets: PolymarketMarket[] = [];
  let nextCursor: string | null = null;
  let pagesScanned = 0;
  let rawCount = 0;
  const MAX_PAGES = 20; // ~2000 markets

  try {
    do {
      const url: string = nextCursor
        ? `${POLYMARKET_BASE}/markets?next_cursor=${nextCursor}`
        : `${POLYMARKET_BASE}/markets`;

      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });

      if (!res.ok) break;

      const json = await res.json();
      const markets: PolymarketMarket[] = json.data ?? [];
      rawCount += markets.length;

      const philly = markets.filter(
        (m) => isPhillyMarket(m.question) && m.active && !m.closed
      );
      phillyMarkets = phillyMarkets.concat(philly);

      nextCursor = json.next_cursor ?? null;
      pagesScanned++;
    } while (nextCursor && pagesScanned < MAX_PAGES);
  } catch {
    // Fall through — return whatever stale cache exists
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
      market_id: m.condition_id,
      question: m.question,
      end_date: m.end_date_iso?.split("T")[0] ?? "",
      yes_price: getYesPrice(m.tokens),
      volume: parseFloat(String(m.volume)) || 0,
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
