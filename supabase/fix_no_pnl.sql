-- ============================================================
-- Fix P&L for settled NO trades where entry_yes_price was
-- stored as the NO cost (1 - YES_price) instead of the YES
-- price, due to the taker_fill_cost_dollars bug.
--
-- Root cause: order-status polling computed
--   entry_yes_price = taker_fill_cost_dollars / filled_count
-- For NO trades, taker_fill_cost_dollars = NO_cost × contracts
-- = (1 - YES_price) × contracts, so the result was the NO cost,
-- not the YES price. YES trades happened to be correct because
-- taker_fill_cost_dollars = YES_price × contracts for YES buys.
--
-- Fix: reset entry_yes_price = market_pct / 100 (the original
-- YES limit price from order placement), then recalculate pnl.
--
-- Run in Supabase SQL Editor (Dashboard → SQL Editor)
-- ============================================================

-- STEP 1: Identify affected NO trades.
-- A corrupted NO trade has entry_yes_price ≈ (1 - market_pct/100),
-- i.e. it's storing the NO cost instead of the YES price.
-- We flag rows where entry_yes_price + market_pct/100 ≈ 1 (they sum
-- to 1, which means they're inverted).
SELECT
  id,
  created_at AT TIME ZONE 'America/New_York'  AS created_et,
  market_id,
  side,
  outcome,
  market_pct,
  ROUND(market_pct::numeric / 100, 4)         AS correct_entry_yes,
  entry_yes_price                              AS stored_entry_yes,
  ROUND(entry_yes_price
        + market_pct::numeric / 100, 4)        AS sum_should_be_1_if_corrupted,
  filled_count,
  pnl                                          AS pnl_current
FROM trades
WHERE side    = 'NO'
  AND outcome IN ('win', 'loss')
  AND entry_yes_price IS NOT NULL
  -- Inverted: stored value + correct value ≈ 1.0 (within 2¢)
  AND ABS((entry_yes_price + market_pct::numeric / 100) - 1.0) < 0.02
ORDER BY created_at DESC
LIMIT 100;


-- ============================================================
-- STEP 2: Fix entry_yes_price and recalculate pnl.
--
-- Formula (mirrors order-status/route.ts):
--   entryYes  = market_pct / 100   (correct YES limit price)
--   sidePrice = 1 - entryYes       (NO cost per contract)
--   Win:  pnl =  filled_count × (1 - sidePrice) =  filled_count × entryYes
--   Loss: pnl = -filled_count × sidePrice        = -filled_count × (1 - entryYes)
-- ============================================================

-- Preview the changes first:
SELECT
  id,
  market_id,
  side,
  outcome,
  filled_count,
  entry_yes_price                              AS entry_yes_current,
  ROUND(market_pct::numeric / 100, 4)          AS entry_yes_correct,
  pnl                                          AS pnl_current,
  ROUND(
    CASE
      WHEN outcome = 'win'
        THEN  filled_count::numeric * (market_pct::numeric / 100)
      WHEN outcome = 'loss'
        THEN -filled_count::numeric * (1 - market_pct::numeric / 100)
    END,
    2
  )                                            AS pnl_correct
FROM trades
WHERE side    = 'NO'
  AND outcome IN ('win', 'loss')
  AND entry_yes_price IS NOT NULL
  AND ABS((entry_yes_price + market_pct::numeric / 100) - 1.0) < 0.02
ORDER BY created_at DESC;


-- Apply the fix (uncomment when ready):
/*
UPDATE trades
SET
  entry_yes_price  = ROUND(market_pct::numeric / 100, 4),
  pnl              = ROUND(
    CASE
      WHEN outcome = 'win'
        THEN  filled_count::numeric * (market_pct::numeric / 100)
      WHEN outcome = 'loss'
        THEN -filled_count::numeric * (1 - market_pct::numeric / 100)
    END,
    2
  ),
  last_checked_at  = NOW()
WHERE side    = 'NO'
  AND outcome IN ('win', 'loss')
  AND entry_yes_price IS NOT NULL
  AND ABS((entry_yes_price + market_pct::numeric / 100) - 1.0) < 0.02;
*/


-- STEP 3: Verify
SELECT id, market_id, side, outcome, filled_count,
       entry_yes_price, pnl, last_checked_at
FROM trades
WHERE side    = 'NO'
  AND outcome IN ('win', 'loss')
ORDER BY created_at DESC
LIMIT 20;
