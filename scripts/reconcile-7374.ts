/**
 * Reconcile missing 73-74° High Temp contracts.
 *
 * From Kalshi UI: 2 open YES contracts at 31¢ avg for KXHIGHPHIL-26MAY06-B73.5
 * Our DB has: 24 sold contracts across 3 sell records
 * Missing: the buy record that resulted in 2 open contracts (probably from
 *          a boost whose DB insert failed)
 *
 * This script creates the missing trade record so the position appears
 * in the app with a Sell button.
 */

import * as fs from "fs";
import * as path from "path";
// Load .env.local first
const envFile = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m) process.env[m[1].trim()] ??= m[2].trim().replace(/^["']|["']$/g, "");
  }
}
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const TICKER = "KXHIGHPHIL-26MAY06-B73.5";

async function main() {
  // 1. Read existing trade to get market_question, target_date, my_pct
  const { data: ref } = await sb
    .from("trades")
    .select("market_question, target_date, my_pct")
    .eq("market_id", TICKER)
    .eq("side", "YES")
    .not("market_question", "is", null)
    .limit(1)
    .single();

  if (!ref) {
    console.error("Could not find reference trade for market_question/target_date. Aborting.");
    process.exit(1);
  }

  console.log("Reference:", ref);

  // 2. Show current state
  const { data: existing } = await sb
    .from("trades")
    .select("id, side, outcome, order_status, filled_count, entry_yes_price")
    .eq("market_id", TICKER)
    .eq("side", "YES");

  console.log("\nExisting YES trades:");
  for (const t of existing ?? []) {
    console.log(`  ${t.id.slice(0,8)} outcome=${t.outcome} filled=${t.filled_count} price=${t.entry_yes_price}`);
  }

  // 3. Insert the missing 2-contract record
  // Known from Kalshi: 2 contracts at 31¢ avg (entry_yes_price = 0.31)
  const MISSING_CONTRACTS = 2;
  const ENTRY_YES_PRICE   = 0.31;
  const my_pct            = ref.my_pct as number | null;
  const edge              = my_pct != null ? my_pct - Math.round(ENTRY_YES_PRICE * 100) : null;

  console.log(`\nInserting: ${MISSING_CONTRACTS} YES contracts @ ${ENTRY_YES_PRICE * 100}¢`);

  const { data: inserted, error } = await sb
    .from("trades")
    .insert([{
      market_id:       TICKER,
      market_question: ref.market_question,
      target_date:     ref.target_date,
      side:            "YES",
      amount_usdc:     MISSING_CONTRACTS * ENTRY_YES_PRICE,
      market_pct:      Math.round(ENTRY_YES_PRICE * 100),
      my_pct:          my_pct,
      edge:            edge,
      signal:          "neutral",
      outcome:         "pending",
      pnl:             null,
      kalshi_order_id: null,        // unknown — lost during failed boost DB insert
      order_status:    "filled",
      entry_yes_price: ENTRY_YES_PRICE,
      filled_count:    MISSING_CONTRACTS,
      remaining_count: null,
    }])
    .select("id")
    .single();

  if (error) {
    console.error("Insert failed:", error.message);
    process.exit(1);
  }

  console.log(`✓ Inserted trade ${inserted!.id}`);
  console.log("\nThe 73-74° position should now show 2 open contracts in the app.");
  console.log("Sell them via the Sell button (or sell directly on Kalshi).");
}

main().catch(console.error);
