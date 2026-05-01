-- Fix trades.outcome constraint to allow 'sold' and 'boosted'
--
-- The original constraint only allowed ('pending', 'win', 'loss').
-- The sell-position and boost-order routes write 'sold' and 'boosted'
-- respectively — those updates were silently rejected at the DB level.
--
-- Run this in the Supabase SQL editor (or via supabase db push).

ALTER TABLE public.trades
  DROP CONSTRAINT IF EXISTS trades_outcome_check;

ALTER TABLE public.trades
  ADD CONSTRAINT trades_outcome_check
  CHECK (outcome IN ('pending', 'win', 'loss', 'sold', 'boosted'));
