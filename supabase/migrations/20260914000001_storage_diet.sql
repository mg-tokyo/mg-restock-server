-- Storage diet (2026-09-14): keep the free-plan DB under 500 MB.
-- See docs/superpowers/plans/2026-09-14-supabase-storage-diet.md.
--
-- 1. Drop indexes that are duplicates or unused.
-- 2. Bounded prune function used by scripts/archive-old-events.mjs --delete
--    (only after rows are verified in the archive project).
-- 3. Daily retention job for accuracy telemetry + pg_cron / pg_net logs.

-- ---------------------------------------------------------------
-- 1. Indexes
-- ---------------------------------------------------------------
-- Exact duplicate of restock_item_events_pkey (shop_type, item_id, timestamp);
-- a btree serves ORDER BY timestamp DESC via a backward scan.
DROP INDEX IF EXISTS public.restock_item_events_shop_item_ts_idx;
-- 5 scans lifetime; created_at ordering is served by restock_events_created_at_idx.
DROP INDEX IF EXISTS public.restock_events_shop_time_idx;
-- source_ip is null on every row since the platform-api poller; no function reads it.
DROP INDEX IF EXISTS public.restock_events_source_time_idx;
-- 116 scans lifetime; the weather join in restock_predictions reads weather_events, not this.
DROP INDEX IF EXISTS public.restock_events_weather_timestamp_idx;

-- ---------------------------------------------------------------
-- 2. Prune function (called by the archive script, never by cron)
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prune_archived_restock_rows(
  p_cutoff_ms bigint,
  p_max_rows integer DEFAULT 20000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
DECLARE
  v_events integer := 0;
  v_items integer := 0;
  v_max integer := LEAST(GREATEST(COALESCE(p_max_rows, 20000), 1000), 50000);
BEGIN
  -- Refuse anything that would leave less than 30 days of hot data.
  IF p_cutoff_ms IS NULL
     OR p_cutoff_ms > (EXTRACT(EPOCH FROM now()) * 1000)::bigint - 30::bigint * 86400000 THEN
    RAISE EXCEPTION 'prune cutoff % is inside the 30-day safety window', p_cutoff_ms;
  END IF;

  WITH victims AS (
    SELECT id FROM public.restock_events
    WHERE "timestamp" < p_cutoff_ms
    ORDER BY "timestamp"
    LIMIT v_max
  )
  DELETE FROM public.restock_events e USING victims v WHERE e.id = v.id;
  GET DIAGNOSTICS v_events = ROW_COUNT;

  WITH victims AS (
    SELECT shop_type, item_id, "timestamp" FROM public.restock_item_events
    WHERE "timestamp" < p_cutoff_ms
    ORDER BY "timestamp"
    LIMIT v_max
  )
  DELETE FROM public.restock_item_events e USING victims v
  WHERE e.shop_type = v.shop_type AND e.item_id = v.item_id AND e."timestamp" = v."timestamp";
  GET DIAGNOSTICS v_items = ROW_COUNT;

  RETURN jsonb_build_object(
    'restock_events_deleted', v_events,
    'restock_item_events_deleted', v_items
  );
END;
$$;

REVOKE ALL ON FUNCTION public.prune_archived_restock_rows(bigint, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_archived_restock_rows(bigint, integer) TO service_role;

-- ---------------------------------------------------------------
-- 3. Daily retention for telemetry that nothing reads beyond a window
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.run_storage_retention()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
DECLARE
  v_snap integer; v_bt integer; v_cron integer; v_net integer;
BEGIN
  -- prediction accuracy log: 60 days (outcomes cascade via FK)
  DELETE FROM public.restock_prediction_snapshots WHERE created_at < now() - interval '60 days';
  GET DIAGNOSTICS v_snap = ROW_COUNT;
  -- backtests: keep the two most recent runs
  DELETE FROM public.restock_item_model_backtests
  WHERE run_id NOT IN (
    SELECT run_id FROM (SELECT DISTINCT run_id, run_at FROM public.restock_item_model_backtests) r
    ORDER BY run_at DESC LIMIT 2);
  GET DIAGNOSTICS v_bt = ROW_COUNT;
  -- pg_cron run log: 3 days
  DELETE FROM cron.job_run_details WHERE end_time < now() - interval '3 days';
  GET DIAGNOSTICS v_cron = ROW_COUNT;
  -- pg_net response log: 1 day (poll-restock enqueues an http_post every 5 min)
  DELETE FROM net._http_response WHERE created < now() - interval '1 day';
  GET DIAGNOSTICS v_net = ROW_COUNT;
  RETURN jsonb_build_object('snapshots', v_snap, 'backtests', v_bt, 'cron_log', v_cron, 'net_log', v_net);
END;
$$;

REVOKE ALL ON FUNCTION public.run_storage_retention() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_storage_retention() TO service_role;

SELECT cron.unschedule('storage-retention')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'storage-retention');
SELECT cron.schedule('storage-retention', '30 4 * * *', $$SELECT public.run_storage_retention();$$);

-- restock_events gets ~640 inserts/day; make autovacuum fire well before bloat builds.
ALTER TABLE public.restock_events SET (autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE public.restock_item_events SET (autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE public.restock_prediction_snapshots SET (autovacuum_vacuum_scale_factor = 0.05);
