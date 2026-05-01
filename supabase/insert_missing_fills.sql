-- ============================================================
-- Insert the 2 missing 66-67° YES fills for Apr 30, 2026
-- market_id and market_question confirmed from error output.
-- ============================================================

-- STEP 1: Confirm existing fills and grab my_pct / edge / signal
-- to reuse for the missing records.
SELECT id, created_at AT TIME ZONE 'America/New_York' AS created_et,
       market_pct, my_pct, edge, signal,
       filled_count, entry_yes_price, amount_usdc, outcome, pnl
FROM trades
WHERE market_id = 'KXHIGHPHIL-26APR30-B66.5'
  AND side = 'YES'
ORDER BY created_at;


-- ============================================================
-- STEP 2: Insert missing fills.
-- my_pct / edge / signal are copied from the existing 35¢ fill
-- (replace the values below if Step 1 shows different numbers).
--
-- P&L for YES win: filled_count × (1 - entry_yes_price)
--   7  × (1 - 0.3443) = 4.59
--  16  × (1 - 0.3563) = 10.30
-- ============================================================

INSERT INTO trades (
  market_id, market_question, target_date,
  side, amount_usdc, market_pct, my_pct, edge, signal,
  outcome, pnl, entry_yes_price, filled_count, remaining_count,
  order_status, kalshi_order_id, created_at, last_checked_at
)
SELECT
  'KXHIGHPHIL-26APR30-B66.5'                       AS market_id,
  'High Temperature Philadelphia · Tomorrow, Apr 30 — 66-67°' AS market_question,
  '2026-04-30'                                      AS target_date,
  'YES'                                             AS side,
  v.amount_usdc,
  v.market_pct,
  t.my_pct,     -- copied from existing fill
  t.edge,       -- copied from existing fill
  t.signal,     -- copied from existing fill
  'win'                                             AS outcome,
  v.pnl,
  v.entry_yes_price,
  v.filled_count,
  0                                                 AS remaining_count,
  'filled'                                          AS order_status,
  NULL                                              AS kalshi_order_id,
  v.created_at,
  NOW()                                             AS last_checked_at
FROM (
  -- The two missing fills as a values table
  VALUES
    (2.41::numeric, 33::integer, 4.59::numeric,  0.3443::numeric, 7::integer,  '2026-04-29 22:03:22+00'::timestamptz),
    (5.70::numeric, 34::integer, 10.30::numeric, 0.3563::numeric, 16::integer, '2026-04-29 22:03:51+00'::timestamptz)
) AS v(amount_usdc, market_pct, pnl, entry_yes_price, filled_count, created_at)
-- Cross-join with the existing fill to inherit my_pct / edge / signal
CROSS JOIN (
  SELECT my_pct, edge, signal
  FROM trades
  WHERE market_id = 'KXHIGHPHIL-26APR30-B66.5'
    AND side = 'YES'
    AND filled_count = 18
  LIMIT 1
) AS t;


-- STEP 3: Verify — should now show 5 fills totalling 49 contracts
SELECT id, created_at AT TIME ZONE 'America/New_York' AS created_et,
       market_pct, filled_count, entry_yes_price, amount_usdc, outcome, pnl
FROM trades
WHERE market_id = 'KXHIGHPHIL-26APR30-B66.5'
  AND side = 'YES'
ORDER BY created_at;
-- Expected: 7+16+18+5+3 = 49 contracts, P&L = 4.59+10.30+11.70+3.30+2.09 = $31.98
