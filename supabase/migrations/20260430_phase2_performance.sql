-- Phase 2: Performance Tracking Foundation
--
-- Adds two append-only result tables that mirror our daily forecasts and
-- recommendations against actual outcomes. Both are idempotent (uniqueness
-- constraints) so the daily settlement job can safely re-run.

create table if not exists forecast_results (
  id                uuid primary key default uuid_generate_v4(),
  forecast_id       uuid not null references forecasts(id) on delete cascade,
  forecast_date     date not null,
  metric            text not null check (metric in ('high', 'low', 'precip')),
  predicted_value   numeric not null,
  -- precip: predicted_value = precip_chance (0–100), actual_value = 100 (rained) or 0 (didn't rain)
  -- high/low: predicted_value and actual_value in °F
  actual_value      numeric not null,
  error             numeric not null generated always as (predicted_value - actual_value) stored,
  abs_error         numeric not null generated always as (abs(predicted_value - actual_value)) stored,
  confidence_level  text not null check (confidence_level in ('very_confident', 'confident', 'uncertain')),
  created_at        timestamptz not null default now(),
  unique (forecast_date, metric)  -- idempotency: one result per day per metric
);

create index if not exists forecast_results_forecast_date_idx on forecast_results (forecast_date);
create index if not exists forecast_results_metric_idx on forecast_results (metric);

create table if not exists recommendation_results (
  id                    uuid primary key default uuid_generate_v4(),
  trade_id              uuid not null references trades(id) on delete cascade,
  market_id             text not null,
  forecast_date         date not null,
  signal                text not null,
  edge                  numeric not null,
  bracket_type          text not null check (bracket_type in ('forecast', 'adjacent_low', 'adjacent_high', 'other')),
  recommended_size      numeric not null,  -- actual amount_usdc from trade
  actually_placed       boolean not null default true,
  actual_size           numeric,           -- same as recommended_size when actually_placed = true
  placed_at             timestamptz,
  would_have_won        boolean not null,
  hypothetical_pnl      numeric not null,  -- P&L at actual recommended_size
  normalized_pnl_at_10  numeric not null,  -- P&L normalized to $10/signal
  actual_pnl            numeric,           -- from trades.pnl (null if not yet settled)
  created_at            timestamptz not null default now(),
  unique (trade_id)     -- idempotency: one result per trade
);

create index if not exists recommendation_results_forecast_date_idx on recommendation_results (forecast_date);
create index if not exists recommendation_results_market_id_idx on recommendation_results (market_id);
create index if not exists recommendation_results_signal_idx on recommendation_results (signal);
