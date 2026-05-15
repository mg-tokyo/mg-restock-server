-- ingest_restock_history has been silently timing out on every call
-- since May 13, causing restock_history to go completely stale while
-- raw restock_events continue to accumulate.
--
-- The edge function calls this via PostgREST which enforces a short
-- statement_timeout (~8s). The function needs more headroom as the
-- dataset grows.

-- Set statement_timeout on the current 4-arg version
ALTER FUNCTION public.ingest_restock_history(text, bigint, jsonb, text)
  SET statement_timeout = '30s';

-- Drop the old 3-arg overload if it exists (prevents PostgREST PGRST203
-- ambiguity and removes dead code — all callers now pass p_weather_id).
DROP FUNCTION IF EXISTS public.ingest_restock_history(text, bigint, jsonb);

-- rebuild_weather_history truncates + rebuilds from weather_events.
-- As the table grows this can also exceed the default timeout.
ALTER FUNCTION public.rebuild_weather_history()
  SET statement_timeout = '30s';
