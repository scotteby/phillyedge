/**
 * Settle the 59-60° Low Temp (KXLOWTPHIL-26MAY05-B59.5) buy fills.
 *
 * These 4 fills have kalshi_order_id=null (sell order ID was never stored),
 * so the HistoryClient auto-poll never runs on them and they stay "pending".
 *
 * Steps:
 *   1. Look up the Kalshi market to get win/loss result
 *   2. Update the 4 pending fills with outcome + pnl
 */

import * as fs from "fs";
import * as path from "path";
const envFile = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m) process.env[m[1].trim()] ??= m[2].trim().replace(/^["']|["']$/g, "");
  }
}
import { createClient } from "@supabase/supabase-js";

const TICKER = "KXLOWTPHIL-26MAY05-B59.5";
const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  // 1. Fetch market result from Kalshi (public endpoint, no auth needed)
  console.log(`Fetching market result for ${TICKER}…`);
  const mktRes  = await fetch(`${KALSHI_BASE}/markets/${encodeURIComponent(TICKER)}`, {
    headers: { Accept: "application/json" },
  });
  if (!mktRes.ok) {
    console.error(`Kalshi market fetch failed: ${mktRes.status}`);
    process.exit(1);
  }
  const mktJson   = await mktRes.json();
  const mkt       = (mktJson.market ?? mktJson) as Record<string, unknown>;
  const mktStatus = String(mkt.status ?? "").toLowerCase();
  const result    = String(mkt.result  ?? "").toLowerCase();

  console.log(`Market status: ${mktStatus}, result: ${result || "(not yet)"}`);

  if (mktStatus !== "finalized" || (result !== "yes" && result !== "no")) {
    console.log("Market not finalized yet — nothing to settle.");
    process.exit(0);
  }

  // 2. Find the pending fills
  const { data: fills, error } = await sb
    .from("trades")
    .select("id, side, filled_count, entry_yes_price, market_pct, amount_usdc, outcome, order_status, remaining_count")
    .eq("market_id", TICKER)
    .eq("outcome", "pending")
    .is("kalshi_order_id", null);  // only the ones without a sell order ID

  if (error) { console.error("DB query failed:", error.message); process.exit(1); }

  const pending = fills ?? [];
  console.log(`\nFound ${pending.length} pending fills to settle:`);

  for (const t of pending) {
    const side      = String(t.side).toLowerCase() as "yes" | "no";
    const entryYes  = (t.entry_yes_price as number | null) ??
      (side === "yes" ? (t.market_pct as number) / 100 : 1 - (t.market_pct as number) / 100);
    const sideCost  = side === "yes" ? entryYes : 1 - entryYes;
    const count     = (t.filled_count as number | null) ?? 0;

    if (count === 0) {
      console.log(`  ${t.id.slice(0,8)} — filled_count=0, skipping`);
      continue;
    }

    const won = result === side;
    const pnl = parseFloat((won
      ? count * (1 - sideCost)
      : -(count * sideCost)
    ).toFixed(2));
    const outcome = won ? "win" : "loss";

    console.log(`  ${t.id.slice(0,8)} filled=${count} side=${side} entryYes=${entryYes} → ${outcome} pnl=${pnl}`);

    const { error: upErr } = await sb
      .from("trades")
      .update({ outcome, pnl })
      .eq("id", t.id);

    if (upErr) {
      console.error(`  ✗ Update failed: ${upErr.message}`);
    } else {
      console.log(`  ✓ Updated`);
    }
  }

  console.log("\nDone. Reload the History page to see the settled positions.");
}

main().catch(console.error);
