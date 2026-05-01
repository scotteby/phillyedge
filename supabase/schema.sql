-- PhillyEdge: Polymarket Weather Trading Dashboard
-- Run this in the Supabase SQL editor to create all required tables.

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- -------------------------------------------------------
-- forecasts
-- -------------------------------------------------------
create table if not exists public.forecasts (
  id             uuid primary key default uuid_generate_v4(),
  created_at     timestamptz not null default now(),
  forecast_date  date not null,
  day_index      int not null check (day_index between 0 and 6),
  target_date    date not null,
  high_temp      int not null,
  low_temp       int not null,
  precip_chance  int not null check (precip_chance between 0 and 100),
  precip_type          text not null check (precip_type in ('None', 'Rain', 'Snow', 'Mix')),
  notes                text,
  forecast_confidence  text not null default 'confident' check (forecast_confidence in ('very_confident', 'confident', 'uncertain'))
);

-- Index for fast lookup by target date
create index if not exists forecasts_target_date_idx on public.forecasts (target_date);
create index if not exists forecasts_forecast_date_idx on public.forecasts (forecast_date);

-- -------------------------------------------------------
-- trades
-- -------------------------------------------------------
create table if not exists public.trades (
  id               uuid primary key default uuid_generate_v4(),
  created_at       timestamptz not null default now(),
  market_id        text not null,
  market_question  text not null,
  target_date      date not null,
  side             text not null check (side in ('YES', 'NO')),
  amount_usdc      numeric(12, 2) not null,
  market_pct       int not null,
  my_pct           int not null,
  edge             int not null,
  signal           text not null check (signal in ('strong-buy', 'buy', 'neutral', 'avoid')),
  outcome          text not null default 'pending' check (outcome in ('pending', 'win', 'loss', 'sold', 'boosted')),
  pnl              numeric(12, 2),
  polymarket_url   text,
  kalshi_order_id  text          -- Kalshi order UUID returned after placement
);

-- -------------------------------------------------------
-- Migration: run these if the table already exists
-- -------------------------------------------------------
-- alter table public.forecasts add column if not exists forecast_confidence text not null default 'confident' check (forecast_confidence in ('very_confident', 'confident', 'uncertain'));
-- alter table public.trades add column if not exists kalshi_order_id  text;
-- alter table public.trades add column if not exists order_status     text;
-- alter table public.trades add column if not exists filled_count     int;
-- alter table public.trades add column if not exists remaining_count  int;
-- alter table public.trades add column if not exists last_checked_at  timestamptz;
-- alter table public.trades add column if not exists entry_yes_price  numeric(6,4);

create index if not exists trades_target_date_idx  on public.trades (target_date);
create index if not exists trades_outcome_idx       on public.trades (outcome);
create index if not exists trades_order_status_idx  on public.trades (order_status);

-- -------------------------------------------------------
-- market_cache
-- -------------------------------------------------------
create table if not exists public.market_cache (
  id          uuid primary key default uuid_generate_v4(),
  fetched_at  timestamptz not null default now(),
  market_id   text not null,
  question    text not null,
  end_date    date not null,
  yes_price   numeric(6, 4) not null,
  volume      numeric(16, 2) not null default 0,
  active      boolean not null default true
);

create index if not exists market_cache_market_id_idx on public.market_cache (market_id);
create index if not exists market_cache_fetched_at_idx on public.market_cache (fetched_at desc);

-- -------------------------------------------------------
-- Row Level Security (no auth for v1 — disable RLS)
-- -------------------------------------------------------
alter table public.forecasts disable row level security;
alter table public.trades disable row level security;
alter table public.market_cache disable row level security;

-- -------------------------------------------------------
-- Phase 2 (performance tracking): see supabase/migrations/20260430_phase2_performance.sql
--   adds forecast_results and recommendation_results tables.
--   precip encoding note: predicted_value = precip_chance (0–100),
--   actual_value = 100 (rained) or 0 (didn't rain), so error is comparable
--   in "percentage points of probability".
-- -------------------------------------------------------
