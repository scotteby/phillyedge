/**
 * Date helpers that are timezone-aware.
 *
 * These markets are Philadelphia-based, so "today" always means the current
 * calendar date in America/New_York — not UTC (which is 4–5 hours ahead and
 * rolls over to the next day well before midnight local time).
 *
 * Safe to call from both server (Node.js, UTC) and client (browser).
 */

const TZ = "America/New_York";

/** Today's date string in Eastern time: "YYYY-MM-DD" */
export function easternToday(): string {
  // en-CA locale formats as YYYY-MM-DD — reliable across all JS runtimes
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
}

/** Tomorrow's date string in Eastern time: "YYYY-MM-DD" */
export function easternTomorrow(): string {
  const d = new Date();
  // Add 24 hours then format — DST-safe because we re-format rather than
  // manipulating UTC milliseconds.
  d.setDate(d.getDate() + 1);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
}
