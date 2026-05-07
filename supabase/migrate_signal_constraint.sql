-- Migration: widen the signal CHECK constraint on trades to include sell/strong-sell
--
-- Background: the original constraint only allowed ('strong-buy','buy','neutral','avoid').
-- Hedge brackets have negative edge, so deriveTradeSignal returns 'sell' or 'strong-sell',
-- which violated the constraint and caused every hedge trade insert to fail silently.
--
-- Run this once in the Supabase SQL Editor.

ALTER TABLE public.trades
  DROP CONSTRAINT IF EXISTS trades_signal_check;

ALTER TABLE public.trades
  ADD CONSTRAINT trades_signal_check
  CHECK (signal IN ('strong-buy', 'buy', 'neutral', 'sell', 'strong-sell', 'avoid'));
