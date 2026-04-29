/**
 * NWS live observation history for Philadelphia International Airport (KPHL).
 * Used to detect when today's high/low is already recorded so we can flag
 * those Kalshi brackets as near-certain outcomes (arbitrage detection).
 *
 * Strategy: fetch all observations since midnight ET today, compute min/max
 * from the temperature field.  minTemperatureLast24Hours is unreliable — null
 * most of the time — so we derive the values ourselves.
 */

export interface NWSObservation {
  observedLow:   number | null;  // °F, rounded — min temp recorded so far today
  observedHigh:  number | null;  // °F, rounded — max temp recorded so far today
  readingCount:  number;         // number of valid observations used
  fetchedAt:     string;
}

function cToF(celsius: number | null | undefined): number | null {
  if (celsius == null) return null;
  return Math.round(celsius * 9 / 5 + 32);
}

/** Today's date in ET as "YYYY-MM-DD". */
function todayET(): string {
  return new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).replace(/(\d{2})\/(\d{2})\/(\d{4})/, "$3-$1-$2"); // MM/DD/YYYY → YYYY-MM-DD
}

export async function fetchNWSObservation(): Promise<NWSObservation> {
  const empty: NWSObservation = { observedLow: null, observedHigh: null, readingCount: 0, fetchedAt: new Date().toISOString() };

  try {
    // Fetch the past 26 hours — guarantees full coverage of today's ET calendar day
    // regardless of DST.  We filter by ET date below so yesterday's tail is excluded.
    const start = new Date(Date.now() - 26 * 3600 * 1000).toISOString();
    const url   = `https://api.weather.gov/stations/KPHL/observations?start=${start}`;

    const res = await fetch(url, {
      headers: {
        "User-Agent": "PhillyEdge/1.0 (scott.m.eby@gmail.com)",
        Accept: "application/geo+json",
      },
      next: { revalidate: 300 }, // re-fetch at most every 5 min
    });

    if (!res.ok) {
      console.warn("[nws] Observations fetch failed:", res.status);
      return empty;
    }

    const json     = await res.json();
    const features = (json.features ?? []) as Array<{ properties: Record<string, unknown> }>;
    const etToday  = todayET();

    const temps: number[] = [];

    for (const f of features) {
      const p         = f.properties;
      const timestamp = p.timestamp as string | undefined;
      if (!timestamp) continue;

      // Only include observations that fall on today's ET calendar date
      const obsDateET = new Date(timestamp).toLocaleDateString("en-US", {
        timeZone: "America/New_York",
        year: "numeric", month: "2-digit", day: "2-digit",
      }).replace(/(\d{2})\/(\d{2})\/(\d{4})/, "$3-$1-$2");

      if (obsDateET !== etToday) continue;

      const tempC = (p.temperature as { value?: number | null } | null)?.value;
      const tempF = cToF(tempC);
      if (tempF !== null) temps.push(tempF);
    }

    if (temps.length === 0) {
      console.warn("[nws] No valid temperature readings for today");
      return empty;
    }

    const observedLow  = Math.min(...temps);
    const observedHigh = Math.max(...temps);

    console.log(
      `[nws] KPHL today (${etToday}): low=${observedLow}°F  high=${observedHigh}°F` +
      `  (from ${temps.length} readings)`
    );

    return {
      observedLow,
      observedHigh,
      readingCount: temps.length,
      fetchedAt:    new Date().toISOString(),
    };
  } catch (err) {
    console.error("[nws] Fetch error:", err);
    return empty;
  }
}

/**
 * Returns { useHigh, useLow } based on current ET time.
 * Low temp:  available after 7 AM ET — overnight low is almost certainly set.
 * High temp: available after 6 PM ET — daytime high is almost certainly set.
 */
export function observationTimeGates(): { useHigh: boolean; useLow: boolean } {
  const nowET  = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const hourET = nowET.getHours();
  return {
    useLow:  hourET >= 7,
    useHigh: hourET >= 18,
  };
}

// ── Market validity time gates ────────────────────────────────────────────────

/** "active" = full signals, "warning" = near resolution, "locked" = past resolution */
export type MarketTimeStatus = "active" | "warning" | "locked";

export interface MarketTimeGates {
  /** KXHIGHPHIL today: active < 11 AM, warning 11–2 PM, locked ≥ 2 PM */
  highStatus: MarketTimeStatus;
  /** KXLOWTPHIL today: active < 8 AM, warning 8–10 AM, locked ≥ 10 AM */
  lowStatus:  MarketTimeStatus;
}

export function todayMarketTimeGates(): MarketTimeGates {
  const nowET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const h = nowET.getHours() + nowET.getMinutes() / 60;
  return {
    highStatus: h < 11 ? "active" : h < 14 ? "warning" : "locked",
    lowStatus:  h < 8  ? "active" : h < 10 ? "warning" : "locked",
  };
}

// ── Live single-observation fetch ─────────────────────────────────────────────

export interface CurrentObservation {
  tempF:      number | null;  // instantaneous temp in °F
  observedAt: string | null;  // ISO timestamp from NWS
  fetchedAt:  string;
}

/**
 * Fetches the latest KPHL observation (single reading, not historical).
 * Used to display "current observed temp" and determine LIKELY WINNER bracket.
 * Cached for 60 s at the fetch level.
 */
export async function fetchCurrentObservation(): Promise<CurrentObservation> {
  const empty: CurrentObservation = { tempF: null, observedAt: null, fetchedAt: new Date().toISOString() };
  try {
    const res = await fetch("https://api.weather.gov/stations/KPHL/observations/latest", {
      headers: {
        "User-Agent": "PhillyEdge/1.0 (scott.m.eby@gmail.com)",
        Accept:       "application/geo+json",
      },
      next: { revalidate: 60 },
    });
    if (!res.ok) {
      console.warn("[nws] Current obs fetch failed:", res.status);
      return empty;
    }
    const json  = await res.json();
    const props = json.properties ?? {};
    const tempC = (props.temperature as { value?: number | null } | null)?.value;
    const tempF = cToF(tempC);
    const observedAt = (props.timestamp as string | null) ?? null;
    console.log(`[nws] Current KPHL: ${tempF ?? "—"}°F at ${observedAt ?? "unknown"}`);
    return { tempF, observedAt, fetchedAt: new Date().toISOString() };
  } catch (err) {
    console.error("[nws] Current obs error:", err);
    return empty;
  }
}
