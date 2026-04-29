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
  observedLow:   number | null;  // °F — minimum temp recorded so far today
  observedHigh:  number | null;  // °F — maximum temp recorded so far today
  highReachedAt: string | null;  // ISO timestamp when the current daily high was FIRST reached
  lowReachedAt:  string | null;  // ISO timestamp when the current daily low was FIRST reached
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
  const empty: NWSObservation = {
    observedLow: null, observedHigh: null,
    highReachedAt: null, lowReachedAt: null,
    readingCount: 0, fetchedAt: new Date().toISOString(),
  };

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

    // Collect { tempF, timestamp } pairs for today's ET date
    const readings: Array<{ tempF: number; timestamp: string }> = [];

    for (const f of features) {
      const p         = f.properties;
      const timestamp = p.timestamp as string | undefined;
      if (!timestamp) continue;

      const obsDateET = new Date(timestamp).toLocaleDateString("en-US", {
        timeZone: "America/New_York",
        year: "numeric", month: "2-digit", day: "2-digit",
      }).replace(/(\d{2})\/(\d{2})\/(\d{4})/, "$3-$1-$2");

      if (obsDateET !== etToday) continue;

      const tempC = (p.temperature as { value?: number | null } | null)?.value;
      const tempF = cToF(tempC);
      if (tempF !== null) readings.push({ tempF, timestamp });
    }

    if (readings.length === 0) {
      console.warn("[nws] No valid temperature readings for today");
      return empty;
    }

    // Sort ascending (oldest → newest) so we can track *when* each extreme was
    // first established.  highReachedAt = the timestamp of the observation that
    // first set the day's running maximum — if the high hasn't risen since then,
    // it's been at its current peak for (now - highReachedAt) hours.
    readings.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    let runningMax: number | null = null;
    let runningMin: number | null = null;
    let highReachedAt: string | null = null;
    let lowReachedAt:  string | null = null;

    for (const r of readings) {
      if (runningMax === null || r.tempF > runningMax) {
        runningMax    = r.tempF;
        highReachedAt = r.timestamp; // timestamp when the current high was first set
      }
      if (runningMin === null || r.tempF < runningMin) {
        runningMin   = r.tempF;
        lowReachedAt = r.timestamp;
      }
    }

    console.log(
      `[nws] KPHL today (${etToday}):` +
      `  low=${runningMin}°F (reached ${lowReachedAt})` +
      `  high=${runningMax}°F (reached ${highReachedAt})` +
      `  (${readings.length} readings)`
    );

    return {
      observedLow:   runningMin,
      observedHigh:  runningMax,
      highReachedAt,
      lowReachedAt,
      readingCount:  readings.length,
      fetchedAt:     new Date().toISOString(),
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

// ── Daily high status ─────────────────────────────────────────────────────────

/**
 * Three-phase classification for how confident we are that today's high is set:
 *   monitoring   — before 2 PM ET; temperature typically still rising
 *   leading      — 2–5 PM ET; near peak but may still rise
 *   likely-final — after 5 PM ET AND the running high hasn't risen for 2+ hours
 *
 * Only used for KXHIGHPHIL (high-temp) markets.  Low-temp markets use the
 * existing observationTimeGates() (useLow after 7 AM).
 */
export type DailyHighStatus = "monitoring" | "leading" | "likely-final";

export function getDailyHighStatus(obs: NWSObservation | null): DailyHighStatus {
  const nowET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const h     = nowET.getHours() + nowET.getMinutes() / 60;

  // After 5 PM: declare likely-final if the high hasn't risen in 2+ hours
  if (h >= 17 && obs?.observedHigh != null && obs?.highReachedAt != null) {
    const hoursSince = (Date.now() - new Date(obs.highReachedAt).getTime()) / 3_600_000;
    if (hoursSince >= 2) return "likely-final";
  }

  if (h >= 14) return "leading";    // 2 PM – 5 PM (or after 5 PM but not yet stable)
  return "monitoring";              // before 2 PM
}

// ── Live single-observation fetch ─────────────────────────────────────────────

/**
 * Fetches the latest KPHL observation (single reading, not historical).
 * Used to display "current observed temp" — NOT for declaring the day's high.
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
