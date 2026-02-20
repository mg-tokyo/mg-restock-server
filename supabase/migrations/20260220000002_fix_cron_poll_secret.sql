-- Fix restock-poll cron job to include x-poll-secret header
--
-- Problem: the original cron job (20260207000002_restock_cron.sql) only sent
-- an Authorization: Bearer header with the service role JWT. After POLL_SECRET
-- was set (20260207000005), the function's auth check required the bearer token
-- to equal POLL_SECRET, which the service role JWT does not. Every cron tick
-- was silently rejected with 403, so no shop or weather data was recorded.
--
-- Fix: drop and recreate the cron job with x-poll-secret in the headers.
-- The x-poll-secret header is checked first in the function, so it passes.

SELECT cron.unschedule('poll-restock');

SELECT cron.schedule(
  'poll-restock',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xjuvryjgrjchbhjixwzh.supabase.co/functions/v1/restock-poll',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhqdXZyeWpncmpjaGJoaml4d3poIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDEwNjI4MywiZXhwIjoyMDg1NjgyMjgzfQ._wJgsTkz8RH3aZCyU53hPtLsNcq8zqGCE4cq8Stf75w',
      'Content-Type', 'application/json',
      'x-poll-secret', '36f79893-0668-48f3-ba40-0ecf79ab10ba'
    ),
    body := '{}'::jsonb
  );
  $$
);
