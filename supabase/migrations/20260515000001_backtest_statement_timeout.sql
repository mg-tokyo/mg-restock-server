-- The backtest function is heavy (~30-60s for 90 days of data).
-- PostgREST's default statement_timeout (8s) kills it.
-- Set a function-level override so it survives regardless of caller.
ALTER FUNCTION public.run_restock_item_model_backtests(integer, integer, integer, integer)
  SET statement_timeout = '120s';
