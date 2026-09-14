# Usage analytics: who is using the database, from which tool

Counts distinct clients per tool from Supabase's own API-gateway logs. Clients send nothing new:
every request they already make carries an `x-client-info` header naming the tool, and the
gateway logs that header alongside the client IP and User-Agent.

## Labels

| Tool | Header value | Where it is set |
|---|---|---|
| QPM-GR userscript | `qpm-gr/<version>` | `QPM-GR/src/utils/supabaseClientInfo.ts`, spread into `restock/dataService.ts` and `itemEventService.ts` |
| QPM FULL PRIVATE overlay | `qpm-gr/13.x.x` | Inherits QPM-GR; the overlay pins its own version (`patches/07-src-utils-versionChecker-ts.patch`), so the version prefix separates it |
| restock-tracker web app | `restock-tracker` | `restock-tracker/src/js/data/api.js` |
| Discord bot | `mgtokyo-discord-bot` | `mgtokyo-discord-bot/src/db/client.ts` |
| Node pollers (GitHub Actions `poll-weather`) | `gemini-server-poll` | `scripts/poll.mjs`, `scripts/poll-weather.mjs` |
| Workflow curl steps | `gh-actions/poll-shops`, `gh-actions/archive-old-events` | `.github/workflows/*.yml` |
| Edge functions writing to the DB | `edge-fn/restock-poll`, `edge-fn/weather-events`, `edge-fn/restock-history` | `supabase/functions/*/index.ts` (needs `supabase functions deploy`) |

Until the edge functions are redeployed, their writes show as
`edge-functions (cron: restock-poll, weather-events)`, derived from the default supabase-js
Deno runtime label.

Requests from clients that predate the header show up as `unlabeled: ...`, grouped by how they
arrived (Referer for browser fetches, `GM_xmlhttpRequest` for userscripts without a Referer).
As users update, the unlabeled rows shrink.

## Running the report

```bash
npm run usage                    # last 24h, one row per tool
npm run usage -- --hours 6       # shorter window
npm run usage -- --paths         # tool x path breakdown (which tables each tool reads)
npm run usage -- --hourly        # distinct IPs per hour (rough concurrent-user proxy)
npm run usage -- --save          # also append the summary to data/usage-history.jsonl
npm run usage -- --json          # raw JSON
```

Columns:

- `ips`: distinct client IPs. The closest thing to "people" without a client identifier.
  Shared households, VPNs and mobile carriers undercount; rotating IPs overcount slightly.
- `ip_ua`: distinct IP + User-Agent pairs. Splits two different browsers behind one IP.
- `requests`: non-preflight requests to `/rest/v1/*` and `/functions/v1/*`.
- `errors`: responses with status 400 or higher.

## Auth

The script calls the Supabase Management API (`/v1/projects/<ref>/analytics/endpoints/logs.all`),
which needs a personal access token. Resolution order:

1. `SUPABASE_ACCESS_TOKEN` in the environment or `.env`.
2. On Windows, the token the Supabase CLI stored in Credential Manager after `supabase login`
   (target `Supabase CLI:supabase`).

Create a token at https://supabase.com/dashboard/account/tokens if neither applies.

Management API gotchas (verified 2026-09-14): without `iso_timestamp_start`/`end` the endpoint
returns only the last minute or so, and timestamps with fractional seconds intermittently return
"Backend error". The script sends `YYYY-MM-DDTHH:MM:SSZ`.

## Retention and history

The free plan keeps API logs for 1 day (Pro: 7 days). `--save` appends one JSON line per run to
`data/usage-history.jsonl`, so a daily run builds a trend without any external service. To
automate it, add a scheduled GitHub Actions job that runs `npm run usage -- --save` and commits the
file, with `SUPABASE_ACCESS_TOKEN` as a repository secret.

## Same query in the dashboard

Dashboard → Logs → Log Explorer, pick a time range, paste:

```sql
select
  coalesce(h.x_client_info, 'unlabeled') as tool,
  count(distinct h.cf_connecting_ip) as ips,
  count(*) as requests
from edge_logs
cross join unnest(metadata) as m
cross join unnest(m.request) as r
cross join unnest(r.headers) as h
where r.method != 'OPTIONS'
  and (r.path like '/rest/v1/%' or r.path like '/functions/v1/%')
group by 1
order by ips desc
```

Other useful header fields on `h`: `user_agent`, `referer`, `cf_connecting_ip`. There is no
`origin` field in the log schema.

## Baseline before labels shipped (2026-09-14, 24h)

| Path | Distinct IPs | Requests |
|---|---|---|
| GET `/rest/v1/weather_predictions` | 101 | 4066 |
| GET `/rest/v1/restock_predictions_mat` | 40 | 120 |
| GET `/rest/v1/shop_type_registry` | 257 | 294 |
| POST `/rest/v1/restock_events` (pollers) | 253 | 1206 |

The 250+ IP rows are the GitHub Actions pollers, whose runner IPs change every job. Once
`gemini-server-poll` is deployed those collapse into one labeled row.
