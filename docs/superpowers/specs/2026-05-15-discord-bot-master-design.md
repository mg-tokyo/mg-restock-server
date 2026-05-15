# Discord Bot — Master Design Overview

**Status:** Brainstorming complete. Sub-project 1 ready for detailed spec.
**Date:** 2026-05-15
**Scope:** Public Discord bot for MagicGarden restock tracking, predictions, weather alerts, and pipeline health.

## Context

The Gemini restock server tracks shop restocks and weather events for MagicGarden/MagicCircle via:

- **Edge function `restock-poll`** (pg_cron, every 5 min): polls `mg-api.ariedam.fr/live`, inserts `restock_events`, calls `ingest_restock_history`, tracks weather.
- **Edge function `restock-history`**: public GET API serving aggregated restock stats to the Gemini userscript.
- **Edge function `weather-events`**: weather submission + retrieval.
- **GitHub Actions `Restock Maintenance`** (every 5 min at :02 offset): snapshots predictions, scores outcomes, daily backtests, weather summary.
- **Database views**: `restock_predictions` (live ETAs + probabilities), `weather_predictions` (weather pattern analysis).

No Discord integration currently exists. Import scripts exist for historical data from Discord JSON exports, but nothing sends data back to Discord.

## Decisions Made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Architecture | Dedicated VPS + Discord Gateway | Persistent connection needed for real-time alerts at scale |
| VPS Provider | Hetzner CX22 | Best price/performance ($3.60/mo, 2 vCPU, 4GB RAM). Reddit consensus favorite. |
| Datacenter | US East (Ashburn) | Low latency to Discord API servers |
| Scale target | Thousands of servers | Public bot, needs sharding at 2,500+ servers |
| Notification types | Failures + daily summary + live events | Full coverage |
| Data source | Supabase (existing tables/views/RPCs) | No duplication — bot queries Supabase directly |

## Sub-Project Breakdown

Each sub-project is a separate spec → plan → implement cycle. They build on each other sequentially.

### Sub-Project 1: VPS Infrastructure

**Goal:** Production-ready Hetzner CX22 server with hardened security, deployment pipeline, and monitoring.

**Scope:**
- Server provisioning (Hetzner CX22, Ubuntu 24.04 LTS, US East)
- Security hardening (SSH keys only, fail2ban, UFW, unattended-upgrades)
- Deployment pipeline (GitHub Actions → SSH deploy, or Docker-based)
- Process management (systemd or Docker Compose)
- Monitoring + alerting (uptime, resource usage, process health)
- DNS setup (optional subdomain for future API use)
- Secrets management (env vars or Vault-lite approach)

**Output:** A server ready to host the bot process, with CI/CD and monitoring in place.

### Sub-Project 2: Discord Bot Core

**Goal:** Bot framework with Gateway connection, slash command registration, multi-server state.

**Scope:**
- Discord.js (v14+) bot framework
- Gateway connection with automatic reconnect + heartbeat
- Slash command registration (global commands)
- Per-server configuration storage (which channel for alerts, which items to track)
- OAuth2 flow for public bot listing
- Sharding preparation (not implemented yet, but architecture supports it)
- Rate limit handling (Discord API limits)
- Graceful shutdown + restart

**Key commands (initial set):**
- `/restock <item>` — show restock prediction for a specific item
- `/weather` — current weather + prediction
- `/status` — pipeline health check
- `/config alerts <channel>` — set alert channel for this server
- `/config items <add|remove> <item>` — configure which items to alert on

**Output:** Bot joins servers, responds to slash commands, stores per-server config.

### Sub-Project 3: Restock Data Integration

**Goal:** Connect bot to Supabase data and format responses as rich Discord embeds.

**Scope:**
- Supabase client (service role key, read-only queries)
- Query `restock_predictions` view for live ETAs
- Query `restock_history` for item stats
- Query `weather_predictions` for weather data
- Query `check_restock_pipeline_health()` for pipeline status
- Rich embed formatting (color-coded by probability, countdown timers)
- Caching layer (don't hit Supabase on every command — 30-60s cache)
- Error handling (Supabase down, query timeout, etc.)

**Output:** All slash commands return accurate, well-formatted data.

### Sub-Project 4: Live Alerts & Notifications

**Goal:** Real-time push notifications to configured Discord channels.

**Scope:**
- Polling loop (query Supabase every 30-60s for changes)
  - OR: Supabase Realtime subscription (if supported for views)
  - OR: Edge function webhook on ingest (pushes to bot's HTTP endpoint)
- Alert types:
  - Rare item appeared in shop (configurable per-server)
  - Weather changed (Rain, Dawn, Frost, AmberMoon, Thunderstorm)
  - Pipeline health alert (ingest stale >15 min)
  - Prediction accuracy milestone (optional)
- Per-server alert channel routing
- Deduplication (don't re-alert same event)
- Rate limiting (max N alerts per minute per server)
- Embed formatting for alerts (distinct from command responses)

**Output:** Servers receive automatic alerts in their configured channel.

### Sub-Project 5: Summaries & Analytics

**Goal:** Periodic digest embeds and analytics commands.

**Scope:**
- Daily summary embed (posted at configurable time):
  - Items restocked today (count by shop)
  - Rarest items seen
  - Weather summary (time in each weather state)
  - Prediction accuracy stats (if enough data)
- Weekly summary (optional)
- `/accuracy` command — show prediction model accuracy stats
- `/trending` command — items with unusual restock patterns
- Scheduled job (cron within the bot process)

**Output:** Servers receive daily digests; users can query analytics on demand.

## Technical Architecture

```
Hetzner CX22 (US East)
├── Discord Bot (Node.js / Discord.js v14)
│   ├── Gateway Connection (WebSocket to Discord)
│   ├── Slash Command Handler
│   ├── Alert Dispatcher (per-server routing)
│   ├── Summary Scheduler (daily/weekly cron)
│   └── Supabase Client (read-only queries)
│
├── Process Manager (systemd or Docker)
├── Monitoring (health endpoint + external uptime check)
└── CI/CD (GitHub Actions → SSH deploy)

Supabase (existing, unchanged)
├── restock_predictions (view) ← bot reads
├── weather_predictions (view) ← bot reads
├── restock_history (table) ← bot reads
├── check_restock_pipeline_health() ← bot reads
└── restock-poll (edge function) ← unchanged, still the sole poller
```

## What Does NOT Change

- Edge function `restock-poll` remains the sole poller (no changes)
- GitHub Actions `Restock Maintenance` continues running auxiliary RPCs
- Supabase schema unchanged (bot is read-only)
- Gemini userscript continues using `restock-history` edge function directly

## Open Questions (for sub-project specs)

1. **Bot language/framework:** Discord.js (Node.js) vs Discord.py vs Eris? Node.js aligns with existing codebase skills.
2. **Config storage:** Supabase table for per-server config, or local SQLite on the VPS?
3. **Alert trigger mechanism:** Poll Supabase, use Realtime subscriptions, or have the edge function push to the bot?
4. **Sharding strategy:** When to implement, manual vs automatic?
5. **Bot verification:** Discord requires verification at 100+ servers. Timeline for application?

## Session History

- 2026-05-15: Fixed GitHub Actions race condition (removed duplicate poller), fixed `ingest_restock_history` statement timeout (2-day data gap), backfilled 1,028 missed events, added pipeline health check RPC + workflow step.
- 2026-05-15: Brainstormed Discord bot. Decided on full decomposition into 5 sub-projects with Hetzner CX22 hosting.
