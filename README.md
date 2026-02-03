# Gemini Server (Shop Restock History)

This repo builds shop restock history without a VPS by polling the live shop snapshot and compiling history + events.

## Data files

- `data/snapshot.json` — last live snapshot
- `data/events.json` — rolling list of restock events (capped)
- `data/history.json` — aggregated per-item history
- `data/history-seed.json` — seed-only history
- `data/history-egg.json` — egg-only history
- `data/history-decor.json` — decor-only history
- `data/meta.json` — metadata

## Scripts

```bash
npm run poll
npm run import:html "C:\path\to\DiscordExport.html"
```

## GitHub Actions

The workflow runs every minute and commits updated data automatically.

## Importing legacy history

Use the Discord HTML export as a base for events + history:

```bash
npm run import:html "Gemini-server\restock examples\Magic Circle - ?? Magic Garden - ping [1392142706964303933].html"
```
