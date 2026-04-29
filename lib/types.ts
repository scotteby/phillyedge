export type ForecastConfidence = "very_confident" | "confident" | "uncertain";

export interface Forecast {
  id: string;
  created_at: string;
  forecast_date: string;
  day_index: number;
  target_date: string;
  high_temp: number;
  low_temp: number;
  precip_chance: number;
  precip_type: "None" | "Rain" | "Snow" | "Mix";
  notes: string | null;
  forecast_confidence: ForecastConfidence | null;
}

export type OrderStatus =
  | "resting"
  | "partially_filled"
  | "filled"
  | "canceled"
  | "expired"
  | null;

export interface Trade {
  id: string;
  created_at: string;
  market_id: string;
  market_question: string;
  target_date: string;
  side: "YES" | "NO";
  amount_usdc: number;
  market_pct: number;
  my_pct: number;
  edge: number;
  signal: "strong-buy" | "buy" | "neutral" | "avoid";
  outcome: "pending" | "win" | "loss";
  pnl: number | null;
  polymarket_url: string | null;
  kalshi_order_id: string | null;
  order_status: OrderStatus;
  filled_count: number | null;
  remaining_count: number | null;
  last_checked_at: string | null;
  entry_yes_price: number | null;   // YES price at placement (0–1 decimal)
}

export interface MarketCache {
  id: string;
  fetched_at: string;
  market_id: string;
  question: string;
  end_date: string;
  yes_price: number;
  volume: number;
  active: boolean;
}

export type Signal = "strong-buy" | "buy" | "neutral" | "avoid";

export interface MarketWithEdge extends MarketCache {
  market_type: "precip" | "high_temp" | "low_temp" | "dry_day" | "unknown";
  threshold?: number;
  my_pct: number;
  market_pct: number;
  edge: number;
  signal: Signal;
}

export interface ForecastDayInput {
  high_temp: number | "";
  low_temp: number | "";
  precip_chance: number | "";
  precip_type: "None" | "Rain" | "Snow" | "Mix";
}
