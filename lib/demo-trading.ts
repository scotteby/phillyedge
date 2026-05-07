/**
 * Automated demo trading — called daily by the 10 AM ET cron.
 *
 * Flow per run:
 *   1. Load tomorrow's forecast and market cache from Supabase.
 *   2. Run groupBracketMarkets (same logic as the Markets page) to identify
 *      primary + hedge brackets for KXHIGHPHIL and KXLOWTPHIL.
 *   3. Place $30 worth of demo orders on each primary bracket, plus a
 *      coverage-ratio-sized hedge order (50 % default) — four orders total.
 *   4. After FILL_WAIT_MS, check fill status for all orders in parallel.
 *      Any that haven't fully filled are cancelled and re-placed at
 *      market price + 1¢ (one boost attempt per order).
 *   5. Log every placed order to the trades table (demo = true).
 *      Idempotent: skips if demo trades for tomorrow already exist.
 *
 * Uses the Kalshi demo API (https://demo-api.kalshi.co) with demo
 * credentials (KALSHI_DEMO_API_KEY_ID / KALSHI_DEMO_PRIVATE_KEY) via
 * buildKalshiAuthHeaders with forceDemo = true.
 *
 * ── Required Supabase migration (run once before first deploy) ──────────────
 *   ALTER TABLE trades ADD COLUMN demo boolean NOT NULL DEFAULT false;
 * ────────────────────────────────────────────────────────────────────────────
 */

import { createServiceClient }  from "@/lib/supabase/server";
import { easternTomorrow }       from "@/lib/dates";
import { groupBracketMarkets }   from "@/lib/brackets";
import { calcHedgeSize, DEFAULT_HEDGE_COVERAGE } from "@/lib/strategy";
import { buildKalshiAuthHeaders } from "@/lib/kalshi-sign";
import type { Forecast, MarketCache } from "@/lib/types";

// ── Constants ─────────────────────────────────────────────────────────────────

const DEMO_BASE          = "https://demo-api.kalshi.co/trade-api/v2";
const ORDERS_API_PATH    = "/trade-api/v2/portfolio/orders";
const BUDGET_PER_MARKET  = 30;    // $30 on the primary bracket for each market
const FILL_WAIT_MS       = 4_000; // pause after all placements before checking fills
const BOOST_WAIT_MS      = 3_000; // pause after boost orders before final check

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DemoOrderRecord {
  ticker:    string;
  series:    string;  // "KXHIGHPHIL" | "KXLOWTPHIL"
  role:      "primary" | "hedge";
  count:     number;  // intended contract count
  price:     number;  // 0–1 decimal, entry yes_price
  amount:    number;  // count × price in dollars
  order_id:  string | null;
  filled:    number;  // contracts confirmed filled
  boosted:   boolean;
  error:     string | null;
}

export interface DemoTradingResult {
  target_date: string;
  orders:      DemoOrderRecord[];
  skipped:     string[];
  errors:      string[];
}

// ── Kalshi demo API helpers ───────────────────────────────────────────────────
// All helpers call buildKalshiAuthHeaders with forceDemo = true so they always
// use KALSHI_DEMO_API_KEY_ID / KALSHI_DEMO_PRIVATE_KEY, regardless of
// KALSHI_DEMO_MODE env var.

/** Place a limit BUY order on the demo API. Returns the order_id. */
async function placeKalshiDemoOrder(
  ticker:     string,
  count:      number,
  priceCents: number, // 1–99 integer cents
): Promise<string | null> {
  const headers = buildKalshiAuthHeaders("POST", ORDERS_API_PATH, true);
  const body    = JSON.stringify({
    ticker,
    action:    "buy",
    side:      "yes",
    type:      "limit",
    count,
    yes_price: priceCents,
  });

  const res  = await fetch(`${DEMO_BASE}/portfolio/orders`, {
    method: "POST", headers, body, cache: "no-store",
  });
  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = (json as Record<string, unknown>)?.message
      ?? (json as Record<string, unknown>)?.error
      ?? JSON.stringify(json).slice(0, 160);
    throw new Error(`Kalshi demo ${res.status}: ${msg}`);
  }

  const j = json as Record<string, unknown>;
  return (j?.order as Record<string, unknown>)?.order_id as string | null
      ?? j?.order_id as string | null
      ?? null;
}

/** Fetch the current fill/remaining counts of a demo order. */
async function getKalshiDemoOrderStatus(orderId: string): Promise<{
  status:    string;
  filled:    number;
  remaining: number;
}> {
  const path    = `${ORDERS_API_PATH}/${orderId}`;
  const headers = buildKalshiAuthHeaders("GET", path, true);
  const res     = await fetch(`${DEMO_BASE}/portfolio/orders/${orderId}`, {
    method: "GET", headers, cache: "no-store",
  });
  if (!res.ok) return { status: "error", filled: 0, remaining: 0 };

  const json  = await res.json().catch(() => ({})) as Record<string, unknown>;
  const order = (json.order ?? json) as Record<string, unknown>;
  return {
    status:    String(order.status ?? ""),
    filled:    parseFloat(String(order.fill_count_fp    ?? order.filled_count    ?? 0)),
    remaining: parseFloat(String(order.remaining_count_fp ?? order.remaining_count ?? 0)),
  };
}

/** Cancel a demo order (best-effort — ignores errors if already filled). */
async function cancelKalshiDemoOrder(orderId: string): Promise<void> {
  try {
    const path    = `${ORDERS_API_PATH}/${orderId}`;
    const headers = buildKalshiAuthHeaders("DELETE", path, true);
    await fetch(`${DEMO_BASE}/portfolio/orders/${orderId}`, {
      method: "DELETE", headers, cache: "no-store",
    });
  } catch {
    // Non-fatal — order may have already executed
  }
}

// ── Order placement + fill monitoring ────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Place one demo order.
 * Returns the orderId (or null on failure) — does NOT wait for fills here;
 * fill monitoring happens in bulk after all orders are submitted.
 */
async function placeOne(
  ticker:     string,
  count:      number,
  priceCents: number,
): Promise<string | null> {
  const orderId = await placeKalshiDemoOrder(ticker, count, priceCents);
  console.log(
    `[demo-trading] placed ${ticker} ${count}×${priceCents}¢ → ${orderId ?? "null"}`
  );
  return orderId;
}

/**
 * Check one order and return boost work to do (if any).
 * Returns: { alreadyFilled, needBoost, boostCount }
 */
async function checkOne(
  orderId:     string,
  intendedCount: number,
): Promise<{ alreadyFilled: number; needBoost: boolean; boostCount: number }> {
  const status = await getKalshiDemoOrderStatus(orderId);
  const alreadyFilled = Math.max(0, Math.round(status.filled));

  // Consider fully filled if: status says so, or remaining ≤ 0
  const isFilled =
    status.status === "executed" ||
    status.status === "filled"   ||
    status.remaining <= 0;

  console.log(
    `[demo-trading] status=${status.status} filled=${alreadyFilled}/${intendedCount} remaining=${status.remaining}`
  );

  if (isFilled) return { alreadyFilled: alreadyFilled || intendedCount, needBoost: false, boostCount: 0 };

  return {
    alreadyFilled,
    needBoost:  true,
    boostCount: intendedCount - alreadyFilled,
  };
}

// ── Supabase trade logging ────────────────────────────────────────────────────

type BracketSnap = {
  market_id:   string;
  question:    string;
  yes_price:   number;
  yes_pct:     number;
  confidence:  number;
  edge:        number;
  signal:      string;
};

/** Returns null on success, or an error string on failure. */
async function logDemoTrade(
  supabase:    ReturnType<typeof createServiceClient>,
  bracket:     BracketSnap,
  orderId:     string | null,
  count:       number,
  filledCount: number,
  targetDate:  string,
): Promise<string | null> {
  const price = bracket.yes_price;

  const row = {
    market_id:       bracket.market_id,
    market_question: bracket.question,
    target_date:     targetDate,
    side:            "YES",
    amount_usdc:     +(count * price).toFixed(2),
    market_pct:      bracket.yes_pct,
    my_pct:          bracket.confidence,
    edge:            bracket.edge,
    signal:          bracket.signal,
    outcome:         "pending",
    pnl:             null,
    kalshi_order_id: orderId,
    order_status:    orderId ? "resting" : null,
    entry_yes_price: price,
    filled_count:    filledCount > 0 ? filledCount : null,
  };

  // Try with demo=true first; fall back without it if the column doesn't exist yet.
  const { error } = await supabase
    .from("trades")
    .insert([{ ...row, demo: true }]);

  if (!error) return null;  // success

  if (error.message.toLowerCase().includes("demo")) {
    // Column not yet added — retry without it
    const msg = `demo column missing — run: ALTER TABLE trades ADD COLUMN demo boolean NOT NULL DEFAULT false;`;
    console.warn(`[demo-trading] ${msg}`);
    const { error: e2 } = await supabase.from("trades").insert([row]);
    if (e2) {
      const msg2 = `Supabase insert failed (retry): ${e2.message}`;
      console.error(`[demo-trading] ${msg2}`);
      return msg2;
    }
    return null;  // retry succeeded (trade in DB but without demo flag)
  }

  // All other errors (e.g. CHECK constraint violation on signal column)
  const msg = `Supabase insert failed for ${bracket.market_id}: ${error.message}`;
  console.error(`[demo-trading] ${msg}`);
  return msg;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runDemoTrading(opts?: { force?: boolean; coverageRatio?: number }): Promise<DemoTradingResult> {
  const supabase   = createServiceClient();
  const targetDate = easternTomorrow();
  const errors:  string[] = [];
  const skipped: string[] = [];
  const orderRecords: DemoOrderRecord[] = [];
  const force        = opts?.force ?? false;
  const coverageRatio =
    opts?.coverageRatio != null && opts.coverageRatio > 0 && opts.coverageRatio <= 1
      ? opts.coverageRatio
      : DEFAULT_HEDGE_COVERAGE;

  console.log(`[demo-trading] Starting demo trading for ${targetDate}${force ? " (forced)" : ""} coverage=${coverageRatio}`);

  // ── 0. Idempotency guard ──────────────────────────────────────────────────
  // Block only when there are demo trades for tomorrow that are still actively
  // resting or partially filled — i.e. real live orders on the exchange.
  // Trades that were canceled (on Kalshi or in-app) don't block a re-run.
  // force=true bypasses the guard entirely and cancels any stale pending rows
  // so fresh placement can proceed cleanly.
  try {
    const { data: existingRows } = await supabase
      .from("trades")
      .select("id, order_status, outcome")
      .eq("target_date", targetDate)
      .eq("demo", true);

    const rows = existingRows ?? [];
    const activeRows = rows.filter(
      (r) =>
        r.outcome === "pending" &&
        (r.order_status === "resting" || r.order_status === "partially_filled"),
    );

    if (activeRows.length > 0 && !force) {
      skipped.push(
        `Demo trades for ${targetDate} already active (${activeRows.length} resting/partial) — skipping. ` +
        `Use force_demo=true to override.`,
      );
      return { target_date: targetDate, orders: [], skipped, errors };
    }

    if (rows.length > 0 && force) {
      // Cancel any live Kalshi demo orders for these trades first, then mark
      // the DB rows as canceled so they don't pollute the history view.
      const { data: pendingRows } = await supabase
        .from("trades")
        .select("id, kalshi_order_id, order_status, outcome")
        .eq("target_date", targetDate)
        .eq("demo", true)
        .in("outcome", ["pending"]);

      const liveOrders = (pendingRows ?? []).filter(
        (r) =>
          r.kalshi_order_id &&
          (r.order_status === "resting" || r.order_status === "partially_filled"),
      );

      if (liveOrders.length > 0) {
        console.log(`[demo-trading] Force: canceling ${liveOrders.length} live Kalshi demo orders…`);
        await Promise.all(
          liveOrders.map((r) => cancelKalshiDemoOrder(r.kalshi_order_id as string)),
        );
      }

      await supabase
        .from("trades")
        .update({ order_status: "canceled", last_checked_at: new Date().toISOString() })
        .eq("target_date", targetDate)
        .eq("demo", true)
        .in("outcome", ["pending"]);
      console.log(`[demo-trading] Force: marked ${rows.length} existing demo trades as canceled`);
    }
  } catch {
    // Column may not exist yet — proceed without the guard
    console.warn("[demo-trading] Idempotency check failed (demo column missing?), proceeding");
  }

  // ── 1. Load forecast for tomorrow ─────────────────────────────────────────
  const { data: fRows, error: fErr } = await supabase
    .from("forecasts")
    .select("*")
    .eq("target_date", targetDate)
    .order("created_at", { ascending: false })
    .limit(1);

  if (fErr) {
    errors.push(`forecasts query: ${fErr.message}`);
    return { target_date: targetDate, orders: orderRecords, skipped, errors };
  }

  const forecast = (fRows?.[0] as Forecast | undefined) ?? null;
  if (!forecast) {
    skipped.push(`No forecast for tomorrow (${targetDate}) — enter a forecast first`);
    return { target_date: targetDate, orders: orderRecords, skipped, errors };
  }

  // ── 2. Load market cache ───────────────────────────────────────────────────
  const { data: mRows, error: mErr } = await supabase
    .from("market_cache")
    .select("*")
    .eq("active", true);

  if (mErr) {
    errors.push(`market_cache query: ${mErr.message}`);
    return { target_date: targetDate, orders: orderRecords, skipped, errors };
  }

  const allMarkets = (mRows ?? []) as MarketCache[];

  // ── 3. Run recommendation logic ────────────────────────────────────────────
  // groupBracketMarkets assigns bracketRole: "primary" / "hedge" / null and
  // populates group.best (primary) + group.secondary (hedge) for each group.
  const { groups } = groupBracketMarkets(allMarkets, [forecast]);

  // ── 4. Filter to tomorrow's high + low markets ────────────────────────────
  const tomorrowGroups = groups.filter(
    (g) =>
      g.obs_date === targetDate &&
      (g.series === "KXHIGHPHIL" || g.series === "KXLOWTPHIL"),
  );

  if (tomorrowGroups.length === 0) {
    skipped.push(
      `No KXHIGHPHIL / KXLOWTPHIL markets found for ${targetDate}` +
      ` — markets may not be listed yet`,
    );
    return { target_date: targetDate, orders: orderRecords, skipped, errors };
  }

  // ── 5. Build order specs ───────────────────────────────────────────────────
  interface OrderSpec {
    series:  string;
    role:    "primary" | "hedge";
    bracket: ReturnType<typeof groupBracketMarkets>["groups"][0]["brackets"][0];
    count:   number;
    price:   number;    // 0–1 decimal
    cents:   number;    // integer cents (1–99)
  }

  const specs: OrderSpec[] = [];

  for (const group of tomorrowGroups) {
    const primary = group.best;
    const hedge   = group.secondary;

    if (!primary || primary.yes_price <= 0) {
      skipped.push(`${group.series}: No primary bracket or price = 0`);
      continue;
    }

    // Primary: buy as many contracts as BUDGET_PER_MARKET allows
    const primaryCount = Math.max(1, Math.floor(BUDGET_PER_MARKET / primary.yes_price));
    specs.push({
      series:  group.series,
      role:    "primary",
      bracket: primary,
      count:   primaryCount,
      price:   primary.yes_price,
      cents:   Math.round(primary.yes_price * 100),
    });

    if (!hedge) {
      skipped.push(
        `${group.series}: No hedge bracket (primary may be open-ended)`,
      );
    } else if (hedge.yes_price <= 0) {
      skipped.push(`${group.series}: Hedge price = 0 — skipped`);
    } else {
      // Hedge: sized by formula to cover coverageRatio of primary loss
      const { secondaryContracts } = calcHedgeSize(
        primaryCount,
        primary.yes_price,
        hedge.yes_price,
        coverageRatio,
      );

      if (secondaryContracts > 0) {
        specs.push({
          series:  group.series,
          role:    "hedge",
          bracket: hedge,
          count:   secondaryContracts,
          price:   hedge.yes_price,
          cents:   Math.round(hedge.yes_price * 100),
        });
      } else {
        skipped.push(`${group.series}: Hedge formula returned 0 contracts`);
      }
    }
  }

  if (specs.length === 0) {
    skipped.push("No valid order specs — nothing to trade");
    return { target_date: targetDate, orders: orderRecords, skipped, errors };
  }

  // ── 6. Place all orders sequentially ──────────────────────────────────────
  // Sequential submission avoids bursting the demo API rate limit.
  const orderIds: Array<string | null> = [];

  for (const spec of specs) {
    let oid: string | null = null;
    try {
      oid = await placeOne(spec.bracket.market_id, spec.count, spec.cents);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[demo-trading] Place failed ${spec.bracket.market_id}:`, msg);
      errors.push(`${spec.series} ${spec.role} placement: ${msg}`);
    }
    orderIds.push(oid);
  }

  // ── 7. Wait, then check fills for all orders in parallel ──────────────────
  console.log(`[demo-trading] Waiting ${FILL_WAIT_MS}ms for fills…`);
  await sleep(FILL_WAIT_MS);

  const checkResults = await Promise.all(
    specs.map((spec, i) => {
      const oid = orderIds[i];
      if (!oid) return Promise.resolve({ alreadyFilled: 0, needBoost: false, boostCount: 0 });
      return checkOne(oid, spec.count).catch(() => ({
        alreadyFilled: 0, needBoost: false, boostCount: 0,
      }));
    }),
  );

  // ── 8. Boost any unfilled orders in parallel ───────────────────────────────
  const boostIds: Array<string | null> = Array(specs.length).fill(null);

  await Promise.all(
    specs.map(async (spec, i) => {
      const { needBoost, boostCount, alreadyFilled } = checkResults[i];
      const origOid = orderIds[i];
      if (!needBoost || !origOid || boostCount <= 0) return;

      // Cancel the resting remainder
      await cancelKalshiDemoOrder(origOid);

      // Re-place at market price + 1¢ (cap at 99¢)
      const boostCents = Math.min(99, spec.cents + 1);
      try {
        boostIds[i] = await placeOne(spec.bracket.market_id, boostCount, boostCents);
        console.log(
          `[demo-trading] Boosted ${spec.bracket.market_id}:` +
          ` orig filled=${alreadyFilled}, boosting ${boostCount}×${boostCents}¢ → ${boostIds[i]}`,
        );
      } catch (err) {
        console.warn(
          `[demo-trading] Boost placement failed for ${spec.bracket.market_id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }),
  );

  // ── 9. Wait for boost fills, then do a final status check ─────────────────
  const anyBoosted = boostIds.some((id) => id !== null);
  if (anyBoosted) {
    console.log(`[demo-trading] Waiting ${BOOST_WAIT_MS}ms for boost fills…`);
    await sleep(BOOST_WAIT_MS);
  }

  const finalFills = await Promise.all(
    specs.map(async (spec, i) => {
      const boostOid = boostIds[i];
      const origOid  = orderIds[i];
      const preFill  = checkResults[i].alreadyFilled;

      if (boostOid) {
        // Check how many the boost order filled
        const bs = await getKalshiDemoOrderStatus(boostOid).catch(
          () => ({ filled: 0, remaining: 0, status: "" }),
        );
        return preFill + Math.max(0, Math.round(bs.filled));
      }

      if (origOid) {
        // No boost — use the fill count from the earlier check (already final)
        const cr = checkResults[i];
        if (!cr.needBoost) return cr.alreadyFilled; // was fully filled
        // Partial fill, no boost (boost placement failed) — return what we have
        return cr.alreadyFilled;
      }

      return 0;
    }),
  );

  // ── 10. Build records + log to Supabase ───────────────────────────────────
  await Promise.all(
    specs.map(async (spec, i) => {
      const origOid  = orderIds[i];
      const boostOid = boostIds[i];
      const finalOid = boostOid ?? origOid;  // active order ID for order-status polling
      const filled   = finalFills[i];
      const boosted  = boostOid !== null;
      const hasError = !origOid ? (errors.find((e) => e.includes(spec.role)) ?? "placement failed") : null;

      orderRecords.push({
        ticker:   spec.bracket.market_id,
        series:   spec.series,
        role:     spec.role,
        count:    spec.count,
        price:    spec.price,
        amount:   +(spec.count * spec.price).toFixed(2),
        order_id: finalOid,
        filled,
        boosted,
        error:    hasError,
      });

      if (!finalOid) return; // placement failed — no Supabase record to write

      const logErr = await logDemoTrade(
        supabase,
        {
          market_id:  spec.bracket.market_id,
          question:   spec.bracket.question,
          yes_price:  spec.price,
          yes_pct:    spec.bracket.yes_pct,
          confidence: spec.bracket.confidence,
          edge:       spec.bracket.edge,
          signal:     spec.bracket.signal,
        },
        finalOid,
        spec.count,
        filled,
        targetDate,
      );
      if (logErr) errors.push(logErr);
    }),
  );

  const placed  = orderRecords.filter((o) => o.order_id !== null).length;
  const boosted = orderRecords.filter((o) => o.boosted).length;
  console.log(
    `[demo-trading] Done: ${placed}/${specs.length} orders placed,` +
    ` ${boosted} boosted, ${errors.length} errors`,
  );

  return { target_date: targetDate, orders: orderRecords, skipped, errors };
}
