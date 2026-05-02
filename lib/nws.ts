/**
 * NWS live observation history for Philadelphia International Airport (KPHL).
 * Used to detect when today's high/low is already recorded so we can flag
 * those Kalshi brackets as near-certain outcomes (arbitrage detection).
 *
 * Strategy: fetch all observations since midnight ET today, compute min/max
 * from the temperature field.  minTemperatureLast24Hours is unreliable — null
 * most of the time — so we derive the values ourselves.
 *
 * Caching: the markets page uses `force-dynamic` which disables Next.js fetch-
 * level caching.  We implement module-level in-memory caches here instead so
 * that repeated page loads within the TTL window return instantly without
 * hitting NWS.  Node.js module state persists for the lifetime of the server
 * process, making this effectively a per-process cache.
 */

// ── In-memory cache ───────────────────────────────────────────────────────────

const OBS_CACHE_TTL_MS      = 10 * 60 * 1000;  // 10 min  — NWS updates hourly
const CURRENT_CACHE_TTL_MS  =  5 * 60 * 1000;  //  5 min  — current temp

interface CacheEntry<T> { data: T; cachedAt: number }

let obsCache:     CacheEntry<NWSObservation>     | null = null;
let currentCache: CacheEntry<CurrentObservation> | null = null;

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

/**
 * Scrape the NWS observation history page (KPHL) and return today's min/max
 * air temperature in °F, rounded to the nearest integer.
 *
 * Why: the NWS JSON API stores temperature in Celsius.  Our cToF() rounds
 * after converting, which can differ by 1°F from the authoritative reading
 * (e.g. 7.78°C → 46.0°F in the API, but the official Fahrenheit reading is
 * 46.9°F which rounds to 47°F).  The obhistory HTML page exposes the native
 * Fahrenheit value directly, matching what Kalshi uses for settlement.
 *
 * Column layout in data rows (0-indexed):
 *   0 = Date (day-of-month, e.g. "1" or "01")
 *   1 = Time (HH:MM)
 *   2 = Wind  3 = Vis  4 = Weather  5 = Sky Cond.
 *   6 = Air temperature (°F)   ← what we want
 *   7 = Dew point  8 = RH  9 = Wind Chill  10 = Heat Index
 *   11–12 = Pressure  13–15 = Precipitation
 */
async function fetchObHistoryTemps(): Promise<{ low: number | null; high: number | null }> {
  const empty = { low: null, high: null };
  try {
    const res = await fetch("https://forecast.weather.gov/data/obhistory/KPHL.html", {
      headers: { "User-Agent": "PhillyEdge/1.0 (scott.m.eby@gmail.com)" },
      next: { revalidate: 300 },
    });
    if (!res.ok) {
      console.warn("[nws] obhistory fetch failed:", res.status);
      return empty;
    }

    const html = await res.text();

    // Today's day-of-month in ET as a number (1–31, no leading zero)
    const todayDay = parseInt(
      new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", day: "numeric" }),
      10,
    );

    let minTemp: number | null = null;
    let maxTemp: number | null = null;

    // Iterate over all <tr> blocks
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch: RegExpExecArray | null;

    while ((rowMatch = rowRe.exec(html)) !== null) {
      const cells: string[] = [];
      const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
        cells.push(cellMatch[1].replace(/<[^>]+>/g, "").trim());
      }

      if (cells.length < 7) continue;

      // Column 0 = day-of-month; skip rows from other days
      const day = parseInt(cells[0], 10);
      if (isNaN(day) || day !== todayDay) continue;

      // Column 6 = instantaneous air temperature in °F
      const temp = parseFloat(cells[6]);
      if (!isNaN(temp)) {
        if (minTemp === null || temp < minTemp) minTemp = temp;
        if (maxTemp === null || temp > maxTemp) maxTemp = temp;
      }

      // Column 8 = 6-hour max temp — only populated every 6 hours but more
      // accurate for the daily high (matches official climate report values).
      // Column 9 = 6-hour min temp — same cadence, better for daily low.
      if (cells.length > 8) {
        const sixHrMax = parseFloat(cells[8]);
        if (!isNaN(sixHrMax)) {
          if (maxTemp === null || sixHrMax > maxTemp) maxTemp = sixHrMax;
        }
      }
      if (cells.length > 9) {
        const sixHrMin = parseFloat(cells[9]);
        if (!isNaN(sixHrMin)) {
          if (minTemp === null || sixHrMin < minTemp) minTemp = sixHrMin;
        }
      }
    }

    console.log(`[nws] obhistory KPHL day=${todayDay}: low=${minTemp}°F high=${maxTemp}°F`);
    return {
      low:  minTemp !== null ? Math.round(minTemp) : null,
      high: maxTemp !== null ? Math.round(maxTemp) : null,
    };
  } catch (err) {
    console.error("[nws] obhistory error:", err);
    return empty;
  }
}

export async function fetchNWSObservation(): Promise<NWSObservation> {
  // Return cached result if still fresh
  if (obsCache && Date.now() - obsCache.cachedAt < OBS_CACHE_TTL_MS) {
    console.log(`[nws] returning cached observation (age ${Math.round((Date.now() - obsCache.cachedAt) / 1000)}s)`);
    return obsCache.data;
  }

  const empty: NWSObservation = {
    observedLow: null, observedHigh: null,
    highReachedAt: null, lowReachedAt: null,
    readingCount: 0, fetchedAt: new Date().toISOString(),
  };

  try {
    // Run the NWS JSON API fetch (for timestamps) and the obhistory HTML scrape
    // (for accurate Fahrenheit readings) in parallel.
    const start = new Date(Date.now() - 26 * 3600 * 1000).toISOString();
    const url   = `https://api.weather.gov/stations/KPHL/observations?start=${start}`;

    // Fire both requests in parallel
    const [res, obhTemps] = await Promise.all([
      fetch(url, {
        headers: {
          "User-Agent": "PhillyEdge/1.0 (scott.m.eby@gmail.com)",
          Accept: "application/geo+json",
        },
        next: { revalidate: 300 },
      }),
      fetchObHistoryTemps(),
    ]);

    if (!res.ok) {
      console.warn("[nws] Observations fetch failed:", res.status);
      // Return obhistory temps if we at least got those
      if (obhTemps.low !== null || obhTemps.high !== null) {
        return { ...empty, observedLow: obhTemps.low, observedHigh: obhTemps.high };
      }
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

    // Prefer obhistory values (native °F, avoids C→F rounding errors).
    // Fall back to the C→F converted values from the JSON API.
    const finalLow  = obhTemps.low  ?? runningMin;
    const finalHigh = obhTemps.high ?? runningMax;

    console.log(
      `[nws] KPHL today (${etToday}):` +
      `  low=${finalLow}°F (obh=${obhTemps.low}, api=${runningMin}, reached ${lowReachedAt})` +
      `  high=${finalHigh}°F (obh=${obhTemps.high}, api=${runningMax}, reached ${highReachedAt})` +
      `  (${readings.length} readings)`
    );

    const result: NWSObservation = {
      observedLow:   finalLow,
      observedHigh:  finalHigh,
      highReachedAt,
      lowReachedAt,
      readingCount:  readings.length,
      fetchedAt:     new Date().toISOString(),
    };
    obsCache = { data: result, cachedAt: Date.now() };
    return result;
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
  // Return cached result if still fresh
  if (currentCache && Date.now() - currentCache.cachedAt < CURRENT_CACHE_TTL_MS) {
    console.log(`[nws] returning cached current obs (age ${Math.round((Date.now() - currentCache.cachedAt) / 1000)}s)`);
    return currentCache.data;
  }

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
    const result: CurrentObservation = { tempF, observedAt, fetchedAt: new Date().toISOString() };
    currentCache = { data: result, cachedAt: Date.now() };
    return result;
  } catch (err) {
    console.error("[nws] Current obs error:", err);
    return empty;
  }
}
