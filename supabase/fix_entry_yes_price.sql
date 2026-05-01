-- ============================================================
-- Fix corrupted entry_yes_price values caused by order-status
-- polling dividing taker_fill_cost_dollars (a FEE) by contract
-- count instead of using avg_yes_price.
--
-- Symptom: entry_yes_price is a very small value (~0.07) even
-- though market_pct (the original limit price) is much higher.
--
-- Run in Supabase SQL Editor (Dashboard → SQL Editor)
-- ============================================================

-- STEP 1: Identify corrupted trades.
-- A trade is suspicious when entry_yes_price is far below the
-- original limit price stored in market_pct.
-- For YES trades:  entry_yes_price should be near market_pct/100
-- For NO  trades:  entry_yes_price should be near 1 - market_pct/100
--
-- We flag rows where entry_yes_price deviates by more than 10¢
-- from the expected limit price — adjust threshold if needed.
SELECT
  id,
  created_at AT TIME ZONE 'America/New_York' AS created_et,
  market_id,
  side,
  market_pct,
  ROUND(market_pct::numeric / 100, 4)                         AS expected_yes_price,
  entry_yes_price                                             AS stored_yes_price,
  ROUND(ABS(entry_yes_price
        - CASE WHEN side = 'YES'
               THEN market_pct::numeric / 100
               ELSE 1 - market_pct::numeric / 100
          END), 4)                                            AS deviation,
  filled_count,
  amount_usdc,
  outcome,
  order_status
FROM trades
WHERE entry_yes_price IS NOT NULL
  AND ABS(entry_yes_price
      - CASE WHEN side = 'YES'
             THEN market_pct::numeric / 100
             ELSE 1 - market_pct::numeric / 100
        END) > 0.10          -- more than 10¢ off from limit price
  AND outcome IN ('pending', 'win', 'loss', 'sold')
ORDER BY created_at DESC
LIMIT 50;


-- ============================================================
-- STEP 2: Fix a specific trade with a known correct price.
--
-- Fill in:
--   <TRADE_ID>           UUID from the SELECT above
--   <CORRECT_YES_PRICE>  The correct entry_yes_price as a decimal
--                        e.g. 0.4134 for 41.34¢
--
-- For a YES trade that was filled at 41.34¢:
--   entry_yes_price = 0.4134
-- For a NO trade that was filled at 41.34¢ (YES side):
--   entry_yes_price = 1 - 0.4134 = 0.5866
-- ============================================================

UPDATE trades
SET
  entry_yes_price  = <CORRECT_YES_PRICE>::numeric,
  last_checked_at  = NOW()
WHERE id = '<TRADE_ID>';


-- ============================================================
-- STEP 3: Bulk-reset corrupted trades to their original limit
-- price (market_pct / 100).  Use this as a safe default when
-- you don't know the exact avg fill price — it's better than
-- 7.7¢ and matches what was recorded at order placement.
--
-- Only touch pending/active trades; leave resolved ones alone
-- so we don't corrupt historical P&L.
-- ============================================================

-- Preview first:
SELECT id, market_id, side, market_pct, entry_yes_price,
  CASE WHEN side = 'YES'
       THEN ROUND(market_pct::numeric / 100, 4)
       ELSE ROUND(1 - market_pct::numeric / 100, 4)
  END AS reset_to
FROM trades
WHERE entry_yes_price IS NOT NULL
  AND ABS(entry_yes_price
      - CASE WHEN side = 'YES'
             THEN market_pct::numeric / 100
             ELSE 1 - market_pct::numeric / 100
        END) > 0.10
  AND outcome = 'pending'
ORDER BY created_at DESC;

-- Then run the actual update (uncomment when ready):
/*
UPDATE trades
SET
  entry_yes_price = CASE WHEN side = 'YES'
                         THEN ROUND(market_pct::numeric / 100, 4)
                         ELSE ROUND(1 - market_pct::numeric / 100, 4)
                    END,
  last_checked_at = NOW()
WHERE entry_yes_price IS NOT NULL
  AND ABS(entry_yes_price
      - CASE WHEN side = 'YES'
             THEN market_pct::numeric / 100
             ELSE 1 - market_pct::numeric / 100
        END) > 0.10
  AND outcome = 'pending';
*/


-- STEP 4: Verify
SELECT id, market_id, side, market_pct,
       ROUND(market_pct::numeric / 100, 4) AS expected,
       entry_yes_price,
       outcome, last_checked_at
FROM trades
WHERE id = '<TRADE_ID>';
