import type { Forecast, MarketCache, MarketWithEdge, Signal } from "./types";

function classifyMarket(question: string): {
  type: MarketWithEdge["market_type"];
  threshold?: number;
} {
  const q = question.toLowerCase();

  // Dry day: "dry day", "no rain", "no precipitation"
  if (q.includes("dry day") || q.includes("no rain") || q.includes("no precip")) {
    return { type: "dry_day" };
  }

  // Precip: "rain", "precipitation", "snow" without a temp threshold
  const precipMatch = q.match(/\bright\b|precipitation|will it rain|chance of rain|chance of snow/);
  if (precipMatch && !q.includes("high") && !q.includes("low") && !q.includes("temperature")) {
    return { type: "precip" };
  }

  // High temp threshold: "high temperature above/over/exceed X"
  const highMatch = q.match(/high(?:\s+temp(?:erature)?)?\s+(?:above|over|exceed(?:s)?|at\s+least|reach(?:es)?)\s+(\d+)/i);
  if (highMatch) {
    return { type: "high_temp", threshold: parseInt(highMatch[1]) };
  }

  // Low temp threshold: "low temperature below/under X"
  const lowMatch = q.match(/low(?:\s+temp(?:erature)?)?\s+(?:below|under|at\s+most|drop(?:s)?\s+(?:to|below))\s+(\d+)/i);
  if (lowMatch) {
    return { type: "low_temp", threshold: parseInt(lowMatch[1]) };
  }

  // Fallback precip detection
  if (q.includes("rain") || q.includes("snow") || q.includes("precip")) {
    return { type: "precip" };
  }

  return { type: "unknown" };
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

  // Find the forecast for the market's target date
  const forecast = forecasts.find((f) => f.target_date === market.end_date);

  const { type, threshold } = classifyMarket(market.question);

  let myPct = 50; // default when no matching forecast

  if (forecast) {
    switch (type) {
      case "precip":
        myPct = forecast.precip_chance;
        break;
      case "dry_day":
        myPct = 100 - forecast.precip_chance;
        break;
      case "high_temp":
        if (threshold !== undefined) {
          myPct = forecast.high_temp > threshold ? 75 : 25;
        }
        break;
      case "low_temp":
        if (threshold !== undefined) {
          myPct = forecast.low_temp < threshold ? 70 : 30;
        }
        break;
      default:
        myPct = 50;
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
