-- Phase 2.5: Recommendation Logging
--
-- Captures every actionable signal (buy / strong-buy) at the moment it is
-- displayed on the markets page, regardless of whether the user trades it.
-- This closes the selection-bias gap in the performance dashboard: we can
-- now compare placed-trade results vs the universe of all signals that
-- appeared, and quantify how much value the user's selection adds.

create table if not exists recommendation_log (
  id                    uuid primary key default uuid_generate_v4(),
  generated_at          timestamptz not null default now(),
  target_date           date not null,
  market_id             text not null,
  market_question       text not null,
  signal                text not null,   -- 'strong-buy' | 'buy'
  edge                  numeric not null,
  bracket_type          text not null check (bracket_type in ('forecast','adjacent_low','adjacent_high','other')),
  my_pct                numeric not null, -- our probability at gen time (0–100)
  market_pct            numeric not null, -- market probability at gen time (0–100)
  side                  text not null check (side in ('YES','NO')),
  confidence_level      text not null,
  acted_on              boolean not null default false,
  trade_id              uuid references trades(id) on delete set null,
  settled               boolean not null default false,
  would_have_won        boolean,
  hypothetical_pnl_at_10 numeric,
  created_at            timestamptz not null default now(),

  -- Dedup: one row per (market_id, target_date, signal, bracket_type) combination.
  -- If signal changes (buy→strong-buy), different signal value = new row.
  unique (market_id, target_date, signal, bracket_type)
);

create index if not exists rec_log_target_date_idx   on recommendation_log (target_date);
create index if not exists rec_log_market_id_idx     on recommendation_log (market_id);
create index if not exists rec_log_generated_at_idx  on recommendation_log (generated_at desc);
create index if not exists rec_log_acted_on_idx      on recommendation_log (acted_on) where not acted_on;
create index if not exists rec_log_settled_idx       on recommendation_log (settled)  where not settled;
