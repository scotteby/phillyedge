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
  const { data, error } = await sb
    .from("trades")
    .select("id, market_id, outcome, order_status, filled_count, remaining_count, entry_yes_price, pnl, amount_usdc, created_at")
    .ilike("market_id", "%B62.5%")
    .order("market_id")
    .order("created_at");
  if (error) { console.error(error); return; }
  let lastMkt = "";
  for (const t of data ?? []) {
    if (t.market_id !== lastMkt) { console.log(`\n── ${t.market_id} ──`); lastMkt = t.market_id; }
    const time = new Date(t.created_at).toLocaleString();
    console.log(`  ${time} | outcome=${t.outcome} | status=${t.order_status} | filled=${t.filled_count} | remaining=${t.remaining_count} | pnl=${t.pnl}`);
  }
}
main();
