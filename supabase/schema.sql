-- PhillyEdge: Supabase schema
-- Recreates the entire database from scratch.
-- Run in the Supabase SQL Editor (Dashboard → SQL Editor → New query).

-- ────────────────────────────────────────────────────────────────────────────
-- Extensions
-- ────────────────────────────────────────────────────────────────────────────
create extension if not exists "uuid-ossp";

-- ────────────────────────────────────────────────────────────────────────────
-- forecasts
-- One row per daily forecast issued.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.forecasts (
  id                   uuid        primary key default uuid_generate_v4(),
  created_at           timestamptz not null default now(),
  forecast_date        date        not null,
  day_index            int         not null check (day_index between 0 and 6),
  target_date          date        not null,
  high_temp            int         not null,
  low_temp             int         not null,
  precip_chance        int         not null check (precip_chance between 0 and 100),
  precip_type          text        not null check (precip_type in ('None', 'Rain', 'Snow', 'Mix')),
  notes                text,
  forecast_confidence  text        not null default 'confident'
                                   check (forecast_confidence in ('very_confident', 'confident', 'uncertain'))
);

create index if not exists forecasts_target_date_idx   on public.forecasts (target_date);
create index if not exists forecasts_forecast_date_idx on public.forecasts (forecast_date);

-- ────────────────────────────────────────────────────────────────────────────
-- trades
-- One row per Kalshi order (or manually-reconciled fill).
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.trades (
  id               uuid         primary key default uuid_generate_v4(),
  created_at       timestamptz  not null default now(),
  market_id        text         not null,
  market_question  text         not null,
  target_date      date         not null,
  side             text         not null check (side in ('YES', 'NO')),
  amount_usdc      numeric(12,2) not null,
  market_pct       int          not null,
  my_pct           int,                      -- null when model pct unavailable
  edge             int,                      -- null when my_pct is null
  signal           text         not null check (signal in ('strong-buy', 'buy', 'neutral', 'sell', 'strong-sell', 'avoid')),
  outcome          text         not null default 'pending'
                                check (outcome in ('pending', 'win', 'loss', 'sold', 'boosted')),
  pnl              numeric(12,2),
  polymarket_url   text,
  kalshi_order_id  text,
  order_status     text,
  filled_count     int,
  remaining_count  int,          -- -1 = sell-order sentinel (resting limit sell attached)
  last_checked_at  timestamptz,
  entry_yes_price  numeric(6,4)  -- actual avg fill price as YES decimal (0–1)
);

create index if not exists trades_target_date_idx   on public.trades (target_date);
create index if not exists trades_outcome_idx        on public.trades (outcome);
create index if not exists trades_order_status_idx   on public.trades (order_status);
create index if not exists trades_market_id_idx      on public.trades (market_id);

-- ────────────────────────────────────────────────────────────────────────────
-- market_cache
-- Cached Kalshi market snapshots used on the Markets page.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.market_cache (
  id          uuid         primary key default uuid_generate_v4(),
  fetched_at  timestamptz  not null default now(),
  market_id   text         not null,
  question    text         not null,
  end_date    date         not null,
  yes_price   numeric(6,4) not null,
  volume      numeric(16,2) not null default 0,
  active      boolean      not null default true
);

create index if not exists market_cache_market_id_idx  on public.market_cache (market_id);
create index if not exists market_cache_fetched_at_idx on public.market_cache (fetched_at desc);

-- ────────────────────────────────────────────────────────────────────────────
-- forecast_results
-- Settled accuracy record for each forecast metric per day.
-- Populated by /api/daily-settlement.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.forecast_results (
  id                uuid         primary key default uuid_generate_v4(),
  forecast_id       uuid         not null references public.forecasts(id) on delete cascade,
  forecast_date     date         not null,
  metric            text         not null check (metric in ('high', 'low', 'precip')),
  -- precip: predicted_value = precip_chance (0–100), actual_value = 100 or 0
  -- high/low: both in °F
  predicted_value   numeric      not null,
  actual_value      numeric      not null,
  error             numeric      not null generated always as (predicted_value - actual_value) stored,
  abs_error         numeric      not null generated always as (abs(predicted_value - actual_value)) stored,
  confidence_level  text         not null check (confidence_level in ('very_confident', 'confident', 'uncertain')),
  created_at        timestamptz  not null default now(),
  unique (forecast_date, metric)   -- one result per day per metric (idempotent upsert)
);

create index if not exists forecast_results_forecast_date_idx on public.forecast_results (forecast_date);
create index if not exists forecast_results_metric_idx        on public.forecast_results (metric);

-- ────────────────────────────────────────────────────────────────────────────
-- recommendation_results
-- Performance record per placed trade.
-- Populated by /api/daily-settlement.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.recommendation_results (
  id                    uuid         primary key default uuid_generate_v4(),
  trade_id              uuid         not null references public.trades(id) on delete cascade,
  market_id             text         not null,
  forecast_date         date         not null,
  signal                text         not null,
  edge                  numeric      not null,
  bracket_type          text         not null check (bracket_type in ('forecast', 'adjacent_low', 'adjacent_high', 'other')),
  recommended_size      numeric      not null,   -- actual amount_usdc from trade
  actually_placed       boolean      not null default true,
  actual_size           numeric,                 -- same as recommended_size when actually_placed = true
  placed_at             timestamptz,
  would_have_won        boolean      not null,
  hypothetical_pnl      numeric      not null,   -- P&L at actual recommended_size
  normalized_pnl_at_10  numeric      not null,   -- P&L normalized to $10/signal
  actual_pnl            numeric,                 -- from trades.pnl (null until settled)
  created_at            timestamptz  not null default now(),
  unique (trade_id)                              -- one result per trade (idempotent upsert)
);

create index if not exists recommendation_results_forecast_date_idx on public.recommendation_results (forecast_date);
create index if not exists recommendation_results_market_id_idx     on public.recommendation_results (market_id);
create index if not exists recommendation_results_signal_idx        on public.recommendation_results (signal);

-- ────────────────────────────────────────────────────────────────────────────
-- recommendation_log
-- Every actionable signal shown on the Markets page, whether traded or not.
-- Enables selection-bias analysis: placed trades vs. universe of all signals.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.recommendation_log (
  id                       uuid         primary key default uuid_generate_v4(),
  generated_at             timestamptz  not null default now(),
  target_date              date         not null,
  market_id                text         not null,
  market_question          text         not null,
  signal                   text         not null,   -- 'strong-buy' | 'buy'
  edge                     numeric      not null,
  bracket_type             text         not null check (bracket_type in ('forecast', 'adjacent_low', 'adjacent_high', 'other')),
  my_pct                   numeric      not null,   -- our probability at generation time (0–100)
  market_pct               numeric      not null,   -- market probability at generation time (0–100)
  side                     text         not null check (side in ('YES', 'NO')),
  confidence_level         text         not null,
  acted_on                 boolean      not null default false,
  trade_id                 uuid         references public.trades(id) on delete set null,
  settled                  boolean      not null default false,
  would_have_won           boolean,
  hypothetical_pnl_at_10   numeric,
  created_at               timestamptz  not null default now(),
  -- One row per (market_id, target_date, signal, bracket_type); new row if signal changes.
  unique (market_id, target_date, signal, bracket_type)
);

create index if not exists rec_log_target_date_idx  on public.recommendation_log (target_date);
create index if not exists rec_log_market_id_idx    on public.recommendation_log (market_id);
create index if not exists rec_log_generated_at_idx on public.recommendation_log (generated_at desc);
create index if not exists rec_log_acted_on_idx     on public.recommendation_log (acted_on)  where not acted_on;
create index if not exists rec_log_settled_idx      on public.recommendation_log (settled)   where not settled;

-- ────────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- All app access uses the service role key (bypasses RLS).
-- Enabling RLS prevents accidental anon/authenticated-role exposure.
-- No policies needed — service role bypasses at the Postgres level.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.trades                 enable row level security;
alter table public.forecasts              enable row level security;
alter table public.market_cache           enable row level security;
alter table public.forecast_results       enable row level security;
alter table public.recommendation_results enable row level security;
alter table public.recommendation_log     enable row level security;
