-- ============================================================
-- Fix entry_yes_price and pnl for the 3 settled NO fills on
-- the 68-69° bracket (KXHIGHPHIL Apr 30, 2026).
--
-- Root cause: entry_yes_price was set from market_pct (the YES
-- price at ORDER PLACEMENT). For maker orders that fill later
-- when the market has moved, actual fill price differs significantly.
--
-- Correct values come from Kalshi order history avg NO prices:
--   16 NO @ 60.75¢ NO  →  YES fill = 39.25¢  →  pnl = 16 × 0.3925 = $6.28
--    3 NO @ 67.67¢ NO  →  YES fill = 32.33¢  →  pnl =  3 × 0.3233 = $0.97
--    1 NO @ 68.00¢ NO  →  YES fill = 32.00¢  →  pnl =  1 × 0.32   = $0.32
-- ============================================================

-- STEP 1: Find the 3 fills and confirm current state
SELECT id,
       created_at AT TIME ZONE 'America/New_York' AS created_et,
       market_id, side, outcome,
       filled_count,
       market_pct,
       entry_yes_price,
       ROUND(1 - entry_yes_price, 4)              AS implied_no_cost,
       pnl
FROM trades
WHERE market_id ILIKE '%KXHIGHPHIL%'
  AND side    = 'NO'
  AND outcome = 'win'
  AND DATE(created_at AT TIME ZONE 'America/New_York') IN ('2026-04-29','2026-04-30')
ORDER BY created_at;


-- STEP 2: Apply corrections using actual Kalshi avg fill prices.
-- Update each fill individually, matched by filled_count + date.

-- 16-contract fill (Apr 29 ~5:36 PM EDT = 21:36 UTC)
UPDATE trades
SET entry_yes_price = 0.3925,   -- 1 - 0.6075 (Kalshi avg NO = 60.75¢)
    pnl             = 6.28,     -- 16 × 0.3925, rounded
    last_checked_at = NOW()
WHERE market_id ILIKE '%KXHIGHPHIL%26APR30%'
  AND side         = 'NO'
  AND outcome      = 'win'
  AND filled_count = 16
  AND DATE(created_at AT TIME ZONE 'America/New_York') = '2026-04-29';

-- 3-contract fill (Apr 30 ~7:58 AM EDT = 11:58 UTC)
UPDATE trades
SET entry_yes_price = 0.3233,   -- 1 - 0.6767 (Kalshi avg NO = 67.67¢)
    pnl             = 0.97,     -- 3 × 0.3233, rounded
    last_checked_at = NOW()
WHERE market_id ILIKE '%KXHIGHPHIL%26APR30%'
  AND side         = 'NO'
  AND outcome      = 'win'
  AND filled_count = 3
  AND DATE(created_at AT TIME ZONE 'America/New_York') = '2026-04-30';

-- 1-contract fill (Apr 30 ~8:18 AM EDT = 12:18 UTC)
UPDATE trades
SET entry_yes_price = 0.32,     -- 1 - 0.68 (Kalshi avg NO = 68¢)
    pnl             = 0.32,     -- 1 × 0.32
    last_checked_at = NOW()
WHERE market_id ILIKE '%KXHIGHPHIL%26APR30%'
  AND side         = 'NO'
  AND outcome      = 'win'
  AND filled_count = 1
  AND DATE(created_at AT TIME ZONE 'America/New_York') = '2026-04-30';


-- STEP 3: Verify — position total should now be $7.57
SELECT id,
       created_at AT TIME ZONE 'America/New_York' AS created_et,
       filled_count,
       entry_yes_price,
       ROUND(1 - entry_yes_price, 4)  AS no_cost_per_contract,
       pnl
FROM trades
WHERE market_id ILIKE '%KXHIGHPHIL%26APR30%'
  AND side    = 'NO'
  AND outcome = 'win'
  AND DATE(created_at AT TIME ZONE 'America/New_York') IN ('2026-04-29','2026-04-30')
ORDER BY created_at;
-- Expected: pnl values $6.28 + $0.97 + $0.32 = $7.57
