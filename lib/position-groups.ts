import type { Trade } from "./types";

export interface PositionGroup {
  key:                  string;        // `${market_id}__${side}`
  market_id:            string;
  bracket:              string;        // label extracted from market_question
  side:                 "YES" | "NO";
  trades:               Trade[];       // sorted by created_at asc
  // Aggregated:
  totalAmount:          number;        // sum of deployedAmount() per trade
  avgEdge:              number;        // weighted average by deployedAmount
  minEdge:              number;
  maxEdge:              number;
  edgesVary:            boolean;       // true when min !== max
  latestSignal:         string;        // signal of most-recently-created trade
  filledContracts:      number;        // sum of filled_count across trades
  totalContracts:       number;        // sum of (filled_count + remaining_count)
  orderStatusSummary:   "filled" | "partial" | "resting" | "mixed";
  outcome:              Trade["outcome"];   // from most recent trade
  totalPnl:             number | null;     // sum of pnl (null if all null)
  totalPotentialProfit: number | null;     // sum of potential profit
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

function getEntryYesPrice(trade: Trade): number {
  if (trade.entry_yes_price != null) return trade.entry_yes_price;
  return trade.side === "YES"
    ? trade.market_pct / 100
    : 1 - trade.market_pct / 100;
}

export function deployedAmountForTrade(trade: Trade): number {
  const entryYes   = getEntryYesPrice(trade);
  const entryPrice = trade.side === "YES" ? entryYes : 1 - entryYes;
  const filled     = trade.filled_count ?? 0;
  const isPartial  =
    (trade.order_status === "canceled" || trade.order_status === "resting" ||
     trade.order_status === "partially_filled") &&
    filled > 0 && filled * entryPrice < trade.amount_usdc - 0.01;
  return isPartial ? filled * entryPrice : trade.amount_usdc;
}

export function getBracketLabel(question: string): string {
  const sep = question.lastIndexOf(" — ");
  return sep >= 0 ? question.slice(sep + 3) : question;
}

export function calcPotentialProfitForTrade(trade: Trade): number | null {
  if (trade.outcome !== "pending") return null;
  const entryYes   = getEntryYesPrice(trade);
  const entryPrice = trade.side === "YES" ? entryYes : 1 - entryYes;
  if (entryPrice <= 0 || entryPrice >= 1) return null;
  const storedFilled = trade.filled_count ?? 0;
  const contracts    = storedFilled > 0
    ? storedFilled
    : Math.floor(trade.amount_usdc / entryPrice);
  if (contracts <= 0) return null;
  return parseFloat((contracts * (1 - entryPrice)).toFixed(2));
}

// ── Main grouping function ────────────────────────────────────────────────────

export function buildPositionGroups(trades: Trade[]): PositionGroup[] {
  const map = new Map<string, Trade[]>();

  for (const t of trades) {
    const key = `${t.market_id}__${t.side}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(t);
  }

  const groups: PositionGroup[] = [];

  for (const [key, groupTrades] of map) {
    // 1. Sort by created_at ascending
    const sorted = [...groupTrades].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

    const firstTrade  = sorted[0];
    const latestTrade = sorted[sorted.length - 1];

    // 2. bracket from first trade's question
    const bracket = getBracketLabel(firstTrade.market_question);

    // 3. totalAmount
    const amounts = sorted.map(deployedAmountForTrade);
    const rawSum  = amounts.reduce((s, a) => s + a, 0);
    const totalAmount = Math.round(rawSum * 100) / 100;

    // 4–7. Edge stats (weighted by deployed amount)
    let weightedEdgeSum = 0;
    let totalWeight     = 0;
    const edges: number[] = [];
    for (let i = 0; i < sorted.length; i++) {
      const weight = Math.max(amounts[i], 1.0); // avoid divide-by-zero
      weightedEdgeSum += sorted[i].edge * weight;
      totalWeight     += weight;
      edges.push(sorted[i].edge);
    }
    const avgEdge  = Math.round((weightedEdgeSum / totalWeight) * 10) / 10;
    const minEdge  = Math.min(...edges);
    const maxEdge  = Math.max(...edges);
    const edgesVary = minEdge !== maxEdge;

    // 8. latestSignal
    const latestSignal = latestTrade.signal;

    // 9. filledContracts
    const filledContracts = sorted.reduce((s, t) => s + (t.filled_count ?? 0), 0);

    // 10. totalContracts — estimate when both are 0
    let totalContracts = 0;
    for (const t of sorted) {
      const filled    = t.filled_count ?? 0;
      const remaining = t.remaining_count ?? 0;
      if (filled === 0 && remaining === 0) {
        // estimate from amount/price
        const entryYes   = getEntryYesPrice(t);
        const entryPrice = t.side === "YES" ? entryYes : 1 - entryYes;
        totalContracts  += entryPrice > 0 ? Math.floor(t.amount_usdc / entryPrice) : 0;
      } else {
        totalContracts += filled + remaining;
      }
    }

    // 11. orderStatusSummary
    let orderStatusSummary: PositionGroup["orderStatusSummary"];
    const statuses = sorted.map((t) => t.order_status);
    const allFilled   = statuses.every((s) => s === "filled");
    const anyResting  = statuses.some((s) => s === "resting");
    const anyPartial  = statuses.some((s) =>
      s === "partially_filled" ||
      (s === "canceled" && (sorted[statuses.indexOf(s)]?.filled_count ?? 0) > 0)
    );
    // More precise partial check using index
    const anyPartialPrecise = sorted.some(
      (t) => t.order_status === "partially_filled" ||
             (t.order_status === "canceled" && (t.filled_count ?? 0) > 0)
    );
    if (allFilled) {
      orderStatusSummary = "filled";
    } else if (anyPartialPrecise) {
      orderStatusSummary = "partial";
    } else if (anyResting) {
      orderStatusSummary = "resting";
    } else {
      orderStatusSummary = "mixed";
    }

    // 12. outcome from latest trade
    const outcome = latestTrade.outcome;

    // 13. totalPnl
    const allPnlNull = sorted.every((t) => t.pnl === null);
    const totalPnl   = allPnlNull
      ? null
      : Math.round(sorted.reduce((s, t) => s + (t.pnl ?? 0), 0) * 100) / 100;

    // 14. totalPotentialProfit
    const potentialSum = sorted.reduce((s, t) => {
      const p = calcPotentialProfitForTrade(t);
      return s + (p ?? 0);
    }, 0);
    const totalPotentialProfit = potentialSum === 0 ? null : potentialSum;

    groups.push({
      key,
      market_id: firstTrade.market_id,
      bracket,
      side: firstTrade.side as "YES" | "NO",
      trades: sorted,
      totalAmount,
      avgEdge,
      minEdge,
      maxEdge,
      edgesVary,
      latestSignal,
      filledContracts,
      totalContracts,
      orderStatusSummary,
      outcome,
      totalPnl,
      totalPotentialProfit,
    });
  }

  // Sort by earliest trade's created_at ascending
  return groups.sort((a, b) =>
    new Date(a.trades[0].created_at).getTime() - new Date(b.trades[0].created_at).getTime()
  );
}
