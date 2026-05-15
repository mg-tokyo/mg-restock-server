-- Lightweight health check called by GitHub Actions every 5 min.
-- Detects silent ingest failures by comparing restock_history freshness
-- against restock_events. Returns is_stale=true if ingest is >15 min behind.
CREATE OR REPLACE FUNCTION public.check_restock_pipeline_health()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_max_last_seen bigint;
  v_max_event timestamptz;
  v_ingest_age_min numeric;
  v_event_age_min numeric;
  v_is_stale boolean;
BEGIN
  SELECT max(last_seen) INTO v_max_last_seen FROM restock_history;
  SELECT max(created_at) INTO v_max_event FROM restock_events;

  v_ingest_age_min := ROUND(EXTRACT(EPOCH FROM (now() - to_timestamp(v_max_last_seen / 1000.0))) / 60);
  v_event_age_min := ROUND(EXTRACT(EPOCH FROM (now() - v_max_event)) / 60);
  v_is_stale := (now() - to_timestamp(v_max_last_seen / 1000.0)) > interval '15 minutes';

  RETURN jsonb_build_object(
    'latest_ingest_ts', to_char(to_timestamp(v_max_last_seen / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'latest_event_ts', to_char(v_max_event AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'ingest_age_minutes', v_ingest_age_min,
    'event_age_minutes', v_event_age_min,
    'is_stale', v_is_stale
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_restock_pipeline_health() TO service_role;
