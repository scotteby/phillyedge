import { createServiceClient } from "@/lib/supabase/server";
import { easternToday } from "@/lib/dates";

const DEMO_MODE   = process.env.KALSHI_DEMO_MODE === "true";
const KALSHI_BASE = DEMO_MODE
  ? "https://demo-api.kalshi.co/trade-api/v2"
  : "https://api.elections.kalshi.com/trade-api/v2";
const CACHE_TTL_MINUTES = 5;

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
  strike_type:          string; // "greater" | "less" | "between"
  // occurrence_datetime is NOT present in the live API; date is parsed from event_ticker
  occurrence_datetime?: string;
  close_time?:          string; // fallback date source
}

function getYesPrice(m: KalshiMarket): number {
  // 1. Last traded price — this is what Kalshi displays as "Chance" in their UI
  const last = parseFloat(m.last_price_dollars ?? "0");
  if (last > 0) return last;

  // 2. Midpoint of a genuine two-sided market (ask must be < $1 — a $1 ask
  //    just means nobody is selling, not an actual offer)
  const bid = parseFloat(m.yes_bid_dollars ?? "0");
  const ask = parseFloat(m.yes_ask_dollars ?? "0");
  if (bid > 0 && ask > 0 && ask < 1) return (bid + ask) / 2;

  // 3. Best available one-sided quote
  if (bid > 0) return bid;
  if (ask > 0 && ask < 1) return ask;

  // 4. No market data yet
  return 0;
}

const MONTH_MAP: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

/** Parse the observation date from an event_ticker like "KXHIGHPHIL-26APR29" → "2026-04-29". */
function parseObsDate(eventTicker: string): string | null {
  const parts = (eventTicker ?? "").toUpperCase().split("-");
  for (let i = parts.length - 1; i >= 0; i--) {
    const match = parts[i].match(/^(\d{2})([A-Z]{3})(\d{2})$/);
    if (match) {
      const mm = MONTH_MAP[match[2]];
      if (mm) return `20${match[1]}-${mm}-${match[3]}`;
    }
  }
  return null;
}

function getEndDate(m: KalshiMarket): string {
  // 1. Prefer occurrence_datetime if present (older API versions)
  if (m.occurrence_datetime) return m.occurrence_datetime.split("T")[0];

  // 2. Parse date from event_ticker: e.g. "KXHIGHPHIL-26APR29" → 2026-04-29
  //    Format: {SERIES}-{YYMONDD}
  const parts = (m.event_ticker ?? "").split("-");
  for (let i = parts.length - 1; i >= 0; i--) {
    const code  = parts[i];
    const match = code.match(/^(\d{2})([A-Z]{3})(\d{2})$/);
    if (match) {
      const mm = MONTH_MAP[match[2]];
      if (mm) return `20${match[1]}-${mm}-${match[3]}`;
    }
  }

  // 3. Fallback: close_time is midnight of the day AFTER the weather day
  if (m.close_time) {
    const d = new Date(m.close_time);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().split("T")[0];
  }

  // 4. Last resort — today (will show up as stale but won't break the insert)
  console.warn("[kalshi] Could not determine end_date for", m.ticker);
  return easternToday();
}

/** Keep the first row per market_id — guards against duplicate DB rows. */
function dedupeByMarketId(rows: Record<string, unknown>[] | null): Record<string, unknown>[] | null {
  if (!rows) return null;
  const seen = new Set<string>();
  return rows.filter((r) => {
    const id = r.market_id as string;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export interface FetchMarketsResult {
  data:         Record<string, unknown>[] | null;
  fromCache:    boolean;
  lastUpdated:  string | null;
  rawCount:     number;
}

export async function fetchAndCacheMarkets(): Promise<FetchMarketsResult> {
  const supabase = createServiceClient();
  const today    = easternToday(); // calendar date in Eastern time

  // ── Cache freshness check ──────────────────────────────────────────────────
  const { data: cached } = await supabase
    .from("market_cache")
    .select("fetched_at")
    .eq("active", true)
    .gte("end_date", today)
    .order("fetched_at", { ascending: false })
    .limit(1);

  if (cached && cached.length > 0) {
    const age = Date.now() - new Date(cached[0].fetched_at).getTime();
    if (age < CACHE_TTL_MINUTES * 60 * 1000) {
      const { data } = await supabase
        .from("market_cache")
        .select("*")
        .eq("active", true)
        .gte("end_date", today)
        .order("volume", { ascending: false });
      return { data: dedupeByMarketId(data), fromCache: true, lastUpdated: cached[0].fetched_at, rawCount: 0 };
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

  // ── Drop past markets (yesterday's still-"open" pending-resolution markets) ─
  // Kalshi keeps previous-day markets in "open" status while waiting for NWS
  // data. Filter them out so only today's and future markets are shown.
  const beforeFilter = allMarkets.length;
  allMarkets = allMarkets.filter((m) => {
    const obs = parseObsDate(m.event_ticker ?? m.ticker);
    return obs === null || obs >= today;
  });
  if (allMarkets.length !== beforeFilter) {
    console.log(
      `[kalshi] Date filter: kept ${allMarkets.length}/${beforeFilter} markets (obs >= ${today})`
    );
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

    const { error: insertErr } = await supabase.from("market_cache").insert(rows);
    if (insertErr) console.error("[kalshi] Cache insert failed:", insertErr.message);
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
    .gte("end_date", today)
    .order("volume", { ascending: false });

  return { data: dedupeByMarketId(data), fromCache: false, lastUpdated: fetchedAt, rawCount };
}
