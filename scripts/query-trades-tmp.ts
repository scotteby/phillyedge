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

  // Check the actual DB constraint on outcome column (via information_schema / pg_constraint)
  const { data: constraintData, error: ce } = await sb.rpc("query_outcome_constraint" as never);
  console.log("constraint rpc:", ce?.message ?? JSON.stringify(constraintData));

  // Try the real approach: pick the most recent pending+filled trade and
  // attempt to update it to 'sold', check error, then revert
  const { data: sample } = await sb
    .from("trades")
    .select("id, outcome, order_status")
    .eq("outcome", "pending")
    .eq("order_status", "filled")
    .limit(1)
    .single();

  if (!sample) { console.log("No pending/filled trade found to test"); return; }
  console.log("Testing with trade:", sample.id);

  const { error: updateErr, count } = await sb
    .from("trades")
    .update({ outcome: "sold" })
    .eq("id", sample.id)
    .select("outcome");
  console.log("Update to sold - error:", updateErr?.message ?? "none");
  console.log("Update to sold - count:", count);

  // Immediately revert
  await sb.from("trades").update({ outcome: "pending" }).eq("id", sample.id);
  console.log("Reverted back to pending");

  // Now verify
  const { data: verify } = await sb.from("trades").select("outcome").eq("id", sample.id).single();
  console.log("Final outcome in DB:", verify?.outcome);
}
main();
