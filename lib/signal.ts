/**
 * Signal helpers — side-relative signal derivation.
 *
 * The bracket's raw signal is always computed from the YES side's edge.
 * When a trade is placed on the NO side, the signal must be flipped so
 * it reflects the quality of the actual position taken.
 *
 *   YES trade: positive edge = good → Strong Buy / Buy / Neutral / Avoid
 *   NO  trade: negative edge = good (market was above our estimate)
 *              edge <= -25 → Strong Buy  (strong NO bracket → correct side)
 *              edge <= -10 → Buy
 *              otherwise   → Neutral / Avoid
 */

/** The four values the DB signal column accepts. */
export type DbSignal = "strong-buy" | "buy" | "neutral" | "avoid";

/**
 * Derive the side-relative signal from edge + side.
 * Safe to call from both API routes (storage) and client components (display).
 */
export function deriveTradeSignal(side: "YES" | "NO", edge: number): DbSignal {
  if (side === "YES") {
    if (edge >= 25) return "strong-buy";
    if (edge >= 10) return "buy";
    if (edge > -10) return "neutral";
    return "avoid";
  } else {
    // NO trade: more negative edge = stronger buy on the NO side
    if (edge <= -25) return "strong-buy";
    if (edge <= -10) return "buy";
    if (edge < 10)   return "neutral";
    return "avoid"; // trading NO on a positive-edge YES bracket
  }
}

/**
 * Human-readable tooltip explaining the signal in context.
 * Shown on the Signal badge in the trades table.
 */
export function signalTooltip(signal: DbSignal, side: "YES" | "NO", edge: number): string {
  const sign = edge >= 0 ? "+" : "";
  if (side === "NO") {
    const sideNote = `NO trade · edge ${sign}${edge}pt at placement`;
    if (signal === "strong-buy") return `Strong Buy — strong edge on this NO trade at placement`;
    if (signal === "buy")        return `Buy — good edge on this NO trade at placement`;
    if (signal === "avoid")      return `Avoid — low/negative edge on this NO trade · ${sideNote}`;
    return `Neutral — ${sideNote}`;
  }
  const sideNote = `YES trade · edge ${sign}${edge}pt at placement`;
  if (signal === "strong-buy") return `Strong Buy — strong edge at placement`;
  if (signal === "buy")        return `Buy — good edge at placement`;
  if (signal === "avoid")      return `Avoid — negative edge at placement`;
  return `Neutral — ${sideNote}`;
}
