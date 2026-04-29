import type { Forecast, MarketCache, MarketWithEdge, Signal } from "./types";

function classifyMarket(question: string, marketId: string): {
  type: MarketWithEdge["market_type"];
  threshold?: number;
  direction?: "greater" | "less";
} {
  const id = marketId.toUpperCase();
  const q = question.toLowerCase();

  // --- Kalshi series detection (ticker-based, reliable) ---
  if (id.startsWith("KXHIGHPHIL")) {
    const threshold = extractThreshold(q);
    const direction = extractDirection(q);
    return { type: "high_temp", threshold, direction };
  }
  if (id.startsWith("KXLOWTPHIL")) {
    const threshold = extractThreshold(q);
    const direction = extractDirection(q);
    return { type: "low_temp", threshold, direction };
  }
  if (id.startsWith("KXPRECIPPHIL")) {
    return { type: "precip" };
  }

  // --- Generic title-based detection (fallback) ---
  // Dry day
  if (q.includes("dry day") || q.includes("no rain") || q.includes("no precip")) {
    return { type: "dry_day" };
  }
  // High temp threshold
  const highMatch = q.match(/high\b.*?(above|over|exceed|>)\s*(\d+)/i) ||
    q.match(/(\d+)\s*°?\s*(or above|or higher)/i);
  if (highMatch && (q.includes("high") || q.includes("warm"))) {
    const threshold = parseInt(highMatch[2] ?? highMatch[1]);
    return { type: "high_temp", threshold, direction: "greater" };
  }
  // Low temp threshold
  const lowMatch = q.match(/low\b.*?(below|under|<)\s*(\d+)/i);
  if (lowMatch) {
    const threshold = parseInt(lowMatch[2]);
    return { type: "low_temp", threshold, direction: "less" };
  }
  // Precip
  if (q.includes("rain") || q.includes("snow") || q.includes("precip")) {
    return { type: "precip" };
  }

  return { type: "unknown" };
}

// Extract threshold from Kalshi titles: ">71°" → 71, "<64°" → 64
function extractThreshold(q: string): number | undefined {
  const m = q.match(/[><](\d+)[°\s]/);
  return m ? parseInt(m[1]) : undefined;
}

// Extract direction from Kalshi titles: "be >71°" → greater, "be <64°" → less
function extractDirection(q: string): "greater" | "less" | undefined {
  if (q.includes(">")) return "greater";
  if (q.includes("<")) return "less";
  return undefined;
}

function toSignal(edge: number): Signal {
  if (edge >= 25) return "strong-buy";
  if (edge >= 10) return "buy";
  if (edge > -10) return "neutral";
  return "avoid";
}

export function calculateEdge(
  market: MarketCache,
  forecasts: Forecast[]
): MarketWithEdge {
  const marketPct = Math.round(market.yes_price * 100);
  const forecast = forecasts.find((f) => f.target_date === market.end_date);
  const { type, threshold, direction } = classifyMarket(market.question, market.market_id);

  let myPct = 50;

  if (forecast) {
    switch (type) {
      case "precip":
        myPct = forecast.precip_chance;
        break;
      case "dry_day":
        myPct = 100 - forecast.precip_chance;
        break;
      case "high_temp":
        if (threshold !== undefined && direction) {
          myPct = direction === "greater"
            ? (forecast.high_temp > threshold ? 75 : 25)
            : (forecast.high_temp < threshold ? 75 : 25);
        }
        break;
      case "low_temp":
        if (threshold !== undefined && direction) {
          myPct = direction === "less"
            ? (forecast.low_temp < threshold ? 75 : 25)
            : (forecast.low_temp > threshold ? 75 : 25);
        }
        break;
    }
  }

  const edge = myPct - marketPct;

  return {
    ...market,
    market_type: type,
    threshold,
    my_pct: myPct,
    market_pct: marketPct,
    edge,
    signal: toSignal(edge),
  };
}

// After calculating edges for all markets, keep only the best-edge bracket per event.
// Kalshi event ticker = first two hyphen segments of ticker: KXHIGHPHIL-26APR29-T71 → KXHIGHPHIL-26APR29
export function deduplicateByEvent(markets: MarketWithEdge[]): MarketWithEdge[] {
  const best = new Map<string, MarketWithEdge>();
  for (const m of markets) {
    const parts = m.market_id.split("-");
    const eventKey = parts.length >= 2 ? `${parts[0]}-${parts[1]}` : m.market_id;
    const existing = best.get(eventKey);
    if (!existing || Math.abs(m.edge) > Math.abs(existing.edge)) {
      best.set(eventKey, m);
    }
  }
  return Array.from(best.values());
}
