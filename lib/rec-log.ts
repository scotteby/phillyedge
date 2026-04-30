/**
 * Phase 2.5: Recommendation Logging
 *
 * Pure-helper module for upserting actionable signals into the
 * `recommendation_log` table, and linking placed trades back to those rows
 * so we can measure selection alpha (the value added by *which* signals the
 * user chooses to trade).
 *
 * Both exported functions MUST be called fire-and-forget. Failures are
 * caught and console-logged — the trading flow must never depend on them.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BracketGroup, BracketMarket } from "./brackets";

// ── Types ────────────────────────────────────────────────────────────────────

export type RecLogBracketType = "forecast" | "adjacent_low" | "adjacent_high" | "other";

interface RecLogRow {
  target_date:      string;
  market_id:        string;
  market_question:  string;
  signal:           string;
  edge:             number;
  bracket_type:     RecLogBracketType;
  my_pct:           number;
  market_pct:       number;
  side:             "YES" | "NO";
  confidence_level: string;
}

// ── Bracket-type derivation ──────────────────────────────────────────────────

/**
 * Categorise a bracket relative to the group's forecast.
 *
 *   relation === 'forecast'          → 'forecast'
 *   relation === 'confirmed' | 'likely_winner'
 *                                    → 'forecast'  (observation has confirmed it)
 *   relation === 'adjacent' | 'neutral':
 *     bracket entirely below forecast → 'adjacent_low'
 *     bracket entirely above forecast → 'adjacent_high'
 *     can't determine                  → 'other'
 */
export function deriveRecLogBracketType(
  bracket:       BracketMarket,
  forecastValue: number | null,
): RecLogBracketType {
  if (bracket.relation === "forecast")     return "forecast";
  if (bracket.relation === "confirmed")    return "forecast";
  if (bracket.relation === "likely_winner") return "forecast";

  if (forecastValue == null) return "other";

  const { min, max } = bracket.range;
  if (max !== null && forecastValue > max) return "adjacent_low";   // bracket sits below forecast
  if (min !== null && forecastValue < min) return "adjacent_high";  // bracket sits above forecast
  return "other";
}

// ── logActionableSignals ─────────────────────────────────────────────────────

/**
 * Upsert actionable signals (buy / strong-buy) from a set of bracket groups
 * into recommendation_log. Uses conflict-do-nothing so repeated page loads
 * don't create duplicate rows. If signal upgrades (buy→strong-buy), the unique
 * key changes so a new row is inserted — that's intentional.
 *
 * MUST be called fire-and-forget (void / after()). Any failure is caught and
 * console-logged; the caller must never await this.
 *
 * `confidenceMap` is keyed by target_date (YYYY-MM-DD) and stores the
 * forecast_confidence value for that day. The caller builds it from the
 * already-fetched forecasts so we don't widen the BracketGroup type.
 */
export async function logActionableSignals(
  groups:        BracketGroup[],
  confidenceMap: Map<string, string>,
  supabase:      SupabaseClient,
): Promise<void> {
  try {
    const rows: RecLogRow[] = [];

    for (const group of groups) {
      const confidenceLevel = confidenceMap.get(group.obs_date) ?? "confident";

      for (const bracket of group.brackets) {
        if (bracket.trade_side == null) continue;
        if (bracket.signal !== "buy" && bracket.signal !== "strong-buy") continue;

        rows.push({
          target_date:      group.obs_date,
          market_id:        bracket.market_id,
          market_question:  bracket.question,
          signal:           bracket.signal,
          edge:             bracket.edge,
          bracket_type:     deriveRecLogBracketType(bracket, group.forecast_value),
          my_pct:           bracket.confidence,
          market_pct:       bracket.yes_pct,
          side:             bracket.trade_side,
          confidence_level: confidenceLevel,
        });
      }
    }

    if (rows.length === 0) return;

    const { error } = await supabase
      .from("recommendation_log")
      .upsert(rows, {
        onConflict:       "market_id,target_date,signal,bracket_type",
        ignoreDuplicates: true,
      });

    if (error) {
      console.error("[rec-log] upsert failed:", error.message);
    } else {
      console.log(`[rec-log] logged ${rows.length} actionable signals`);
    }
  } catch (err) {
    console.error("[rec-log] logActionableSignals threw:", err);
  }
}

// ── linkTradeToRecommendation ────────────────────────────────────────────────

/**
 * After a trade is placed, find the matching open recommendation in
 * recommendation_log and mark it as acted on.
 *
 * Matching criteria:
 *   - same market_id
 *   - same target_date
 *   - acted_on = false
 *   - generated_at within last 24 hours
 *
 * Note: does NOT match on signal/bracket_type — a trade placed at a
 * slightly different signal tier still links to the rec that was shown.
 * Takes the most-recently-generated matching row.
 *
 * MUST be called fire-and-forget. Failure is silently logged.
 */
export async function linkTradeToRecommendation(
  tradeId:    string,
  marketId:   string,
  targetDate: string,
  supabase:   SupabaseClient,
): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data, error: selErr } = await supabase
      .from("recommendation_log")
      .select("id")
      .eq("market_id",  marketId)
      .eq("target_date", targetDate)
      .eq("acted_on",    false)
      .gt("generated_at", cutoff)
      .order("generated_at", { ascending: false })
      .limit(1);

    if (selErr) {
      console.error("[rec-log] link select failed:", selErr.message);
      return;
    }

    const match = data?.[0];
    if (!match) {
      console.log("[rec-log] No matching recommendation for trade", tradeId);
      return;
    }

    const { error: updErr } = await supabase
      .from("recommendation_log")
      .update({ acted_on: true, trade_id: tradeId })
      .eq("id", match.id);

    if (updErr) {
      console.error("[rec-log] link update failed:", updErr.message);
    } else {
      console.log(`[rec-log] linked trade ${tradeId} → rec ${match.id}`);
    }
  } catch (err) {
    console.error("[rec-log] linkTradeToRecommendation threw:", err);
  }
}
