-- Enable Row Level Security on all public tables.
--
-- All server-side access uses the service role key, which bypasses RLS,
-- so enabling RLS here has no effect on the application.  It silences the
-- Supabase Security Advisor "RLS Disabled in Public" warnings and prevents
-- any accidental exposure via the anon/authenticated Postgres roles.

alter table public.trades               enable row level security;
alter table public.forecasts            enable row level security;
alter table public.market_cache         enable row level security;
alter table public.forecast_results     enable row level security;
alter table public.recommendation_results enable row level security;
alter table public.recommendation_log   enable row level security;
