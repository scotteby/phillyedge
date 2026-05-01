-- ============================================================
-- Insert the 2 missing 66-67° YES fills for Apr 30, 2026
-- that were placed on Kalshi but never saved to Supabase.
--
-- Kalshi order history shows:
--   7 contracts  @ avg 34.43¢  limit 33¢  Apr 29 18:03:22 EDT
--  16 contracts  @ avg 35.63¢  limit 34¢  Apr 29 18:03:51 EDT
--  18 contracts  @ avg 36.61¢  limit 35¢  Apr 29 18:03:52 EDT  ← already in DB
--   5 contracts  @ avg 34.00¢  limit 34¢  Apr 30 07:54:59 EDT  ← already in DB
--   3 contracts  @ avg 32.00¢  limit 32¢  Apr 30 08:14:28 EDT  ← already in DB
-- ============================================================

-- STEP 1: Find the existing fill to copy market_id / market_question / target_date.
SELECT id, market_id, market_question, target_date, side,
       market_pct, my_pct, edge, signal, entry_yes_price,
       filled_count, amount_usdc, outcome, pnl, created_at
FROM trades
WHERE market_id ILIKE '%KXHIGHPHIL%'
  AND side    = 'YES'
  AND outcome = 'win'
  AND filled_count = 18
  AND DATE(created_at AT TIME ZONE 'America/New_York') = '2026-04-29'
ORDER BY created_at;

-- ============================================================
-- STEP 2: Insert the 2 missing fills.
-- Replace <MARKET_ID> and <MARKET_QUESTION> with values from Step 1.
-- The kalshi_order_id values are unknown (order placed outside DB)
-- so we leave them null; outcome and pnl are set from Kalshi data.
--
-- P&L for YES win: filled_count × (1 - entry_yes_price)
--   7  × (1 - 0.3443) = 7  × 0.6557 = 4.59
--  16  × (1 - 0.3563) = 16 × 0.6437 = 10.30
-- ============================================================

INSERT INTO trades (
  market_id, market_question, target_date,
  side, amount_usdc, market_pct, my_pct, edge, signal,
  outcome, pnl, entry_yes_price, filled_count, remaining_count,
  order_status, kalshi_order_id, created_at, last_checked_at
)
VALUES
  -- 7 contracts @ 34.43¢ avg  (limit 33¢, Apr 29 18:03:22 EDT = 22:03:22 UTC)
  (
    '<MARKET_ID>',
    '<MARKET_QUESTION>',
    '2026-04-30',
    'YES',
    2.41,        -- cost: 7 × 0.3443
    33,          -- market_pct = limit price in cents
    NULL,        -- my_pct unknown
    NULL,        -- edge unknown
    NULL,        -- signal unknown
    'win',
    4.59,        -- 7 × (1 - 0.3443)
    0.3443,      -- avg fill price
    7,
    0,
    'filled',
    NULL,        -- kalshi_order_id unknown
    '2026-04-29 22:03:22+00',
    NOW()
  ),
  -- 16 contracts @ 35.63¢ avg  (limit 34¢, Apr 29 18:03:51 EDT = 22:03:51 UTC)
  (
    '<MARKET_ID>',
    '<MARKET_QUESTION>',
    '2026-04-30',
    'YES',
    5.70,        -- cost: 16 × 0.3563
    34,          -- market_pct = limit price in cents
    NULL,
    NULL,
    NULL,
    'win',
    10.30,       -- 16 × (1 - 0.3563)
    0.3563,      -- avg fill price
    16,
    0,
    'filled',
    NULL,
    '2026-04-29 22:03:51+00',
    NOW()
  );


-- STEP 3: Verify — should now see 5 fills totalling 49 contracts
SELECT id, created_at AT TIME ZONE 'America/New_York' AS created_et,
       market_id, side, filled_count, entry_yes_price,
       amount_usdc, outcome, pnl
FROM trades
WHERE market_id = '<MARKET_ID>'
  AND side = 'YES'
ORDER BY created_at;
-- Expected totals: 7+16+18+5+3 = 49 contracts, P&L ≈ 4.59+10.30+11.70+3.30+2.09 = $31.98
