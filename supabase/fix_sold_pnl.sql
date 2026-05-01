-- ============================================================
-- Fix P&L on manually-marked-sold trades
-- Run in Supabase SQL Editor (Dashboard → SQL Editor)
-- ============================================================

-- STEP 1: Find the trades you want to fix.
-- Adjust the WHERE clause if needed (market_id prefix, date, etc.)
SELECT
  id,
  created_at AT TIME ZONE 'America/New_York' AS created_et,
  market_id,
  side,
  market_pct,
  entry_yes_price,
  COALESCE(entry_yes_price, market_pct::numeric / 100)                  AS entry_yes_used,
  CASE WHEN side = 'YES'
       THEN COALESCE(entry_yes_price, market_pct::numeric / 100)
       ELSE 1 - COALESCE(entry_yes_price, market_pct::numeric / 100)
  END                                                                    AS entry_cost_per_contract,
  filled_count,
  amount_usdc,
  pnl                                                                    AS pnl_current,
  outcome,
  order_status
FROM trades
WHERE market_id LIKE 'KXLOWTPHIL%'
  AND outcome = 'sold'
  AND DATE(created_at AT TIME ZONE 'America/New_York') = CURRENT_DATE
ORDER BY created_at;


-- ============================================================
-- STEP 2: Correct the P&L for each trade.
--
-- Fill in:
--   <TRADE_ID>          UUID from the SELECT above
--   <SELL_PRICE_CENTS>  Actual sell price as an integer (e.g. 2 for 2¢, 97 for 97¢)
--
-- Formula (same as /api/mark-sold):
--   entry_yes   = entry_yes_price  (or market_pct/100 if null)
--   entry_cost  = YES side → entry_yes       NO side → 1 - entry_yes
--   sell_yes    = sell_price_cents / 100
--   sell_procs  = YES side → sell_yes        NO side → 1 - sell_yes
--   contracts   = filled_count  (or floor(amount_usdc / entry_cost) if null/0)
--   pnl         = (sell_procs - entry_cost) * contracts
-- ============================================================

-- Trade 1
UPDATE trades
SET
  pnl = ROUND(
    (
      -- sell proceeds per contract
      CASE WHEN side = 'YES'
           THEN (<SELL_PRICE_CENTS_1>::numeric / 100)
           ELSE 1 - (<SELL_PRICE_CENTS_1>::numeric / 100)
      END
      -
      -- entry cost per contract
      CASE WHEN side = 'YES'
           THEN COALESCE(entry_yes_price, market_pct::numeric / 100)
           ELSE 1 - COALESCE(entry_yes_price, market_pct::numeric / 100)
      END
    )
    *
    -- number of contracts
    COALESCE(
      NULLIF(filled_count, 0),
      FLOOR(amount_usdc /
        CASE WHEN side = 'YES'
             THEN COALESCE(entry_yes_price, market_pct::numeric / 100)
             ELSE 1 - COALESCE(entry_yes_price, market_pct::numeric / 100)
        END
      )
    ),
    2
  ),
  last_checked_at = NOW()
WHERE id = '<TRADE_ID_1>';


-- Trade 2 (same template — just change the placeholders)
UPDATE trades
SET
  pnl = ROUND(
    (
      CASE WHEN side = 'YES'
           THEN (<SELL_PRICE_CENTS_2>::numeric / 100)
           ELSE 1 - (<SELL_PRICE_CENTS_2>::numeric / 100)
      END
      -
      CASE WHEN side = 'YES'
           THEN COALESCE(entry_yes_price, market_pct::numeric / 100)
           ELSE 1 - COALESCE(entry_yes_price, market_pct::numeric / 100)
      END
    )
    *
    COALESCE(
      NULLIF(filled_count, 0),
      FLOOR(amount_usdc /
        CASE WHEN side = 'YES'
             THEN COALESCE(entry_yes_price, market_pct::numeric / 100)
             ELSE 1 - COALESCE(entry_yes_price, market_pct::numeric / 100)
        END
      )
    ),
    2
  ),
  last_checked_at = NOW()
WHERE id = '<TRADE_ID_2>';


-- STEP 3: Verify
SELECT id, pnl, outcome, last_checked_at
FROM trades
WHERE id IN ('<TRADE_ID_1>', '<TRADE_ID_2>');
