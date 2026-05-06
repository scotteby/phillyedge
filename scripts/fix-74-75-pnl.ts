import * as fs from "fs"; import * as path from "path";
const envFile = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m) process.env[m[1].trim()] ??= m[2].trim().replace(/^["']|["']$/g, "");
  }
}
import { createClient } from "@supabase/supabase-js";
async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const SELL_PRICE = 0.56; // Kalshi confirms both sells at 56¢ on May 4

  // b003be93: 13 contracts, Kalshi avg buy 31.42¢
  // pnl = (0.56 - 0.3142) × 13 = $3.20
  const pnl_13 = parseFloat(((SELL_PRICE - 0.3142) * 13).toFixed(2));

  // fde905bc: 6 contracts, Kalshi avg buy 45.83¢
  // pnl = (0.56 - 0.4583) × 6 = $0.61
  const pnl_6  = parseFloat(((SELL_PRICE - 0.4583) * 6).toFixed(2));

  console.log(`Corrected pnl_13 = +$${pnl_13}, pnl_6 = +$${pnl_6}`);

  const { error: e1 } = await sb
    .from("trades")
    .update({ entry_yes_price: SELL_PRICE, pnl: pnl_13 })
    .eq("id", "b003be93-e840-42b4-b056-7ce1c564fb78");
  console.log("b003be93 update:", e1?.message ?? "OK");

  const { error: e2 } = await sb
    .from("trades")
    .update({ entry_yes_price: SELL_PRICE, pnl: pnl_6 })
    .eq("id", "fde905bc-8a55-4d88-adb8-d41bd834f94b");
  console.log("fde905bc update:", e2?.message ?? "OK");

  // Verify
  const { data } = await sb
    .from("trades")
    .select("id, filled_count, entry_yes_price, pnl, outcome")
    .in("id", ["b003be93-e840-42b4-b056-7ce1c564fb78", "fde905bc-8a55-4d88-adb8-d41bd834f94b"]);
  console.log("\nVerification:");
  for (const t of data ?? []) console.log(JSON.stringify(t));
}
main();
