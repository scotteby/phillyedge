import type { Trade } from "./types";

// ── Types ─────────────────────────────────────────────────────────────────────

export type PositionState = "OPEN" | "CLOSED" | "PARTIALLY_CLOSED" | "SETTLED";

export interface Position {
  key:              string;      // `${market_id}__${side}`
  market_id:        string;
  bracket:          string;      // from getBracketLabel(market_question)
  side:             "YES" | "NO";
  state:            PositionState;

  fills:            Trade[];     // trades with actual contracts (sorted by created_at asc)
  pendingOrders:    Trade[];     // resting/void-cancelled — no contracts yet

  contractsBought:  number;      // sum of contracts from non-sold fills
  contractsSold:    number;      // sum of contracts from "sold" fills
  netContracts:     number;      // = max(0, bought - sold)

  avgBuyPrice:      number;      // weighted avg per-contract cost (0–1, side-specific)

  realizedPnl:      number;      // sum of pnl from sold + settled fills
  ifCorrectPayout:  number;      // netContracts × (1 − avgBuyPrice) + realizedPnl

  soldBuyAmount:    number;      // contractsSold × avgBuyPrice (cost of what was sold)
  sellProceeds:     number;      // soldBuyAmount + sum(pnl of sold fills)
  targetDate:       string;
}

// ── Pure helpers (exported for tests and HistoryClient) ───────────────────────

/** Entry YES price as a 0–1 decimal. */
export function getEntryYesPrice(trade: Trade): number {
  if (trade.entry_yes_price != null) return trade.entry_yes_price;
  return trade.side === "YES"
    ? trade.market_pct / 100
    : 1 - trade.market_pct / 100;
}

/** Number of contracts that actually filled for this trade. */
export function getContractsForFill(trade: Trade): number {
  if ((trade.filled_count ?? 0) > 0) return trade.filled_count!;
  const entryYes   = getEntryYesPrice(trade);
  const entryPrice = trade.side === "YES" ? entryYes : 1 - entryYes;
  return entryPrice > 0 ? Math.floor(trade.amount_usdc / entryPrice) : 0;
}

/** Strip the series+date prefix, leaving just the bracket label. */
export function getBracketLabel(question: string): string {
  const sep = question.lastIndexOf(" — ");
  return sep >= 0 ? question.slice(sep + 3) : question;
}

/** True when this trade contributed actual contracts to the position. */
export function hasFills(t: Trade): boolean {
  return (
    (t.filled_count ?? 0) > 0 ||
    t.order_status === "filled" ||
    t.order_status === "partially_filled" ||
    t.outcome === "sold" ||
    t.outcome === "win" ||
    t.outcome === "loss"
  );
}

/** True when this trade is a pending/resting order with no contracts yet. */
export function isOnlyPendingOrder(t: Trade): boolean {
  if (hasFills(t)) return false;
  // Only truly resting orders count as "pending" — cancelled and boosted orders
  // are done and should not appear in the Pending Orders section.
  return t.order_status === "resting";
}

// ── Main builder ──────────────────────────────────────────────────────────────

export function buildPositions(trades: Trade[]): Position[] {
  // 1. Group by `${market_id}__${side}`
  const map = new Map<string, Trade[]>();
  for (const t of trades) {
    const key = `${t.market_id}__${t.side}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(t);
  }

  const positions: Position[] = [];

  for (const [key, groupTrades] of map) {
    // 2. Sort by created_at asc
    const sorted = [...groupTrades].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

    // 3. Split into fills and pendingOrders.
    // A trade can appear in BOTH buckets:
    //   fills         → position math (contracts held, avg price, P&L)
    //   pendingOrders → PENDING ORDERS display with Boost / Cancel buttons
    //
    // A partially-filled order has fills already counted in the position, but
    // the remaining resting contracts still need to be visible so the user
    // can boost them. We include a trade in pendingOrders if it is still
    // live on Kalshi (order_status "resting" or "partially_filled" AND
    // outcome still "pending"). We do NOT gate on remaining_count because
    // Kalshi may not return that field in every polling response, leaving it
    // as 0 in the DB even though contracts are still resting.
    const isLiveOrder = (t: Trade): boolean =>
      t.outcome === "pending" &&
      (t.order_status === "resting" || t.order_status === "partially_filled");

    const fills         = sorted.filter(hasFills);
    const pendingOrders = sorted.filter(
      (t) => isOnlyPendingOrder(t) || (hasFills(t) && isLiveOrder(t)),
    );

    // 4. Skip groups with neither
    if (fills.length === 0 && pendingOrders.length === 0) continue;

    const firstTrade = sorted[0];
    const bracket    = getBracketLabel(firstTrade.market_question);

    // 5. Contract math
    const soldFills = fills.filter((t) => t.outcome === "sold");
    const buyFills  = fills.filter((t) => t.outcome !== "sold");

    const contractsBought = buyFills.reduce((s, t) => s + getContractsForFill(t), 0);
    const contractsSold   = soldFills.reduce((s, t) => s + getContractsForFill(t), 0);

    if (contractsSold > contractsBought) {
      console.warn(
        `[position-model] contractsSold (${contractsSold}) > contractsBought (${contractsBought}) for key=${key} — clamping to 0`
      );
    }
    const netContracts = Math.max(0, contractsBought - contractsSold);

    // 6. Weighted avg buy price across ALL fills (sold + non-sold)
    let totalWeightedPrice = 0;
    let totalContracts     = 0;
    for (const t of fills) {
      const c = getContractsForFill(t);
      const entryYes   = getEntryYesPrice(t);
      const entryPrice = t.side === "YES" ? entryYes : 1 - entryYes;
      totalWeightedPrice += c * entryPrice;
      totalContracts     += c;
    }
    const avgBuyPrice = totalContracts > 0 ? totalWeightedPrice / totalContracts : 0;

    // 7. Realized P&L
    // For win/loss we compute from entry_yes_price rather than the stored pnl,
    // because pnl was persisted when entry_yes_price may have been wrong (the
    // taker-fill-cost bug).  entry_yes_price has since been corrected by polling,
    // so computing on-the-fly is more accurate.
    // For sold fills we still use the stored pnl (set correctly at sell time).
    //
    // Edge case: when a market settles, order-status polling may have updated
    // only SOME fills to "win"/"loss" while others remain "pending".  We detect
    // this by finding any settled fill in the group and applying that same
    // outcome to all still-pending fills so the full position P&L is shown.
    const settledOutcome =
      (fills.find((t) => t.outcome === "win")  ? "win"  : null) ??
      (fills.find((t) => t.outcome === "loss") ? "loss" : null);

    const realizedPnl = fills.reduce((s, t) => {
      if (t.outcome === "sold") {
        return s + (t.pnl ?? 0);
      }
      // Use the position's settled outcome for fills still marked "pending"
      const effectiveOutcome =
        (t.outcome === "pending" && settledOutcome) ? settledOutcome : t.outcome;

      if (effectiveOutcome === "win" || effectiveOutcome === "loss") {
        const entryYes = getEntryYesPrice(t);
        const count    = getContractsForFill(t);
        const sideCost = t.side === "YES" ? entryYes : 1 - entryYes;
        return s + (effectiveOutcome === "win"
          ? count * (1 - sideCost)
          : -count * sideCost);
      }
      return s;
    }, 0);

    // 8. If-correct payout
    const ifCorrectPayout = netContracts * (1 - avgBuyPrice) + realizedPnl;

    // 9. soldBuyAmount
    const soldBuyAmount = contractsSold * avgBuyPrice;

    // 10. sellProceeds
    const soldPnlSum  = soldFills.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const sellProceeds = soldBuyAmount + soldPnlSum;

    // 11. State
    const hasSettled = fills.some((t) => t.outcome === "win" || t.outcome === "loss");
    let state: PositionState;
    if (hasSettled) {
      state = "SETTLED";
    } else if (contractsSold === 0) {
      state = "OPEN";
    } else if (netContracts === 0) {
      state = "CLOSED";
    } else {
      state = "PARTIALLY_CLOSED";
    }

    positions.push({
      key,
      market_id:       firstTrade.market_id,
      bracket,
      side:            firstTrade.side as "YES" | "NO",
      state,
      fills,
      pendingOrders,
      contractsBought,
      contractsSold,
      netContracts,
      avgBuyPrice,
      realizedPnl,
      ifCorrectPayout,
      soldBuyAmount,
      sellProceeds,
      targetDate:      firstTrade.target_date,
    });
  }

  // 12. Sort by earliest trade's created_at
  return positions.sort((a, b) => {
    const aFirst = a.fills[0] ?? a.pendingOrders[0];
    const bFirst = b.fills[0] ?? b.pendingOrders[0];
    return new Date(aFirst.created_at).getTime() - new Date(bFirst.created_at).getTime();
  });
}
