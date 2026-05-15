# Discord Bot — Project Manifest

**Master spec:** `docs/superpowers/specs/2026-05-15-discord-bot-master-design.md`
**Started:** 2026-05-15

## Sub-Projects

### SP1: VPS Infrastructure
- **Status:** Not started
- **Spec:** (not yet written)
- **Plan:** (not yet written)
- **Depends on:** Nothing (first in chain)
- **Deliverable:** Hardened Hetzner CX22 with CI/CD and monitoring
- **Key decisions needed:** Docker vs bare systemd, monitoring stack choice

### SP2: Discord Bot Core
- **Status:** Not started
- **Spec:** (not yet written)
- **Plan:** (not yet written)
- **Depends on:** SP1 (needs server to deploy to)
- **Deliverable:** Bot joins servers, registers slash commands, stores per-server config
- **Key decisions needed:** Discord.js vs alternatives, config storage (Supabase table vs SQLite)

### SP3: Restock Data Integration
- **Status:** Not started
- **Spec:** (not yet written)
- **Plan:** (not yet written)
- **Depends on:** SP2 (needs bot framework)
- **Deliverable:** Slash commands return live predictions and stats as rich embeds
- **Key decisions needed:** Caching strategy, embed design

### SP4: Live Alerts & Notifications
- **Status:** Not started
- **Spec:** (not yet written)
- **Plan:** (not yet written)
- **Depends on:** SP3 (needs data integration)
- **Deliverable:** Automatic alerts for restocks, weather, pipeline health
- **Key decisions needed:** Poll vs Realtime vs webhook trigger, alert rate limiting

### SP5: Summaries & Analytics
- **Status:** Not started
- **Spec:** (not yet written)
- **Plan:** (not yet written)
- **Depends on:** SP4 (needs alert infrastructure)
- **Deliverable:** Daily digests, accuracy reports, trending items
- **Key decisions needed:** Summary schedule, embed layout

## Pre-Requisites Completed (2026-05-15)

- [x] Fix GitHub Actions race condition (removed duplicate poller)
- [x] Fix `ingest_restock_history` statement timeout (30s override)
- [x] Fix `score_restock_prediction_outcomes` PostgREST overload
- [x] Fix `run_restock_item_model_backtests` statement timeout (120s override)
- [x] Backfill 1,028 missed restock events (May 13–15 gap)
- [x] Add `check_restock_pipeline_health()` RPC
- [x] Add health check step to maintenance workflow
- [x] Drop old 3-arg `ingest_restock_history` overload

## How to Resume

Start a new Claude session and say:

> Read `docs/superpowers/discord-bot-manifest.md` and `docs/superpowers/specs/2026-05-15-discord-bot-master-design.md`, then start the spec for the next incomplete sub-project.

The agent will:
1. Read both docs for full context
2. Identify the next sub-project by status
3. Run the brainstorming → spec → plan → implement cycle for it
4. Update this manifest when done
