// Move raw restock rows older than the live retention window into the cold
// archive project (mg-restock-archive), verify every row landed, then prune
// them from the live project. Weather events are copied too but never pruned
// from live (weather_summary / weather_history rebuild from the full table).
//
//   node scripts/archive-old-events.mjs             # copy + verify only (dry run for the delete)
//   node scripts/archive-old-events.mjs --delete    # copy + verify + prune live
//   RETENTION_DAYS=180 (default) controls the cutoff.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (live)
//      ARCHIVE_SUPABASE_URL, ARCHIVE_SERVICE_ROLE_KEY (archive)

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function loadEnvFile() {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key && process.env[key] === undefined) process.env[key] = trimmed.slice(eq + 1).trim();
  }
}
loadEnvFile();

const LIVE = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
const ARCHIVE = { url: process.env.ARCHIVE_SUPABASE_URL, key: process.env.ARCHIVE_SERVICE_ROLE_KEY };
for (const [name, cfg] of Object.entries({ LIVE, ARCHIVE })) {
  if (!cfg.url || !cfg.key) {
    console.error(`Missing ${name === "LIVE" ? "SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY" : "ARCHIVE_SUPABASE_URL/ARCHIVE_SERVICE_ROLE_KEY"}`);
    process.exit(1);
  }
}

const DELETE = process.argv.includes("--delete");
const RETENTION_DAYS = Math.max(30, Number(process.env.RETENTION_DAYS) || 180);
const CUTOFF_MS = Date.now() - RETENTION_DAYS * 86_400_000;
const PAGE = 1000;
const VERIFY_BATCH = 200;
const TABLES = [
  { name: "restock_events", conflict: "fingerprint", prune: true },
  { name: "weather_events", conflict: "fingerprint", prune: false },
];

function headers(cfg, extra = {}) {
  return { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json", ...extra };
}

async function request(cfg, pathname, init = {}) {
  const res = await fetch(`${cfg.url}/rest/v1/${pathname}`, { ...init, headers: headers(cfg, init.headers) });
  if (!res.ok) throw new Error(`${init.method || "GET"} ${pathname}: ${res.status} ${await res.text()}`);
  return res;
}

async function countOlderThan(cfg, table) {
  const res = await request(cfg, `${table}?select=id&timestamp=lt.${CUTOFF_MS}`, {
    method: "HEAD",
    headers: { Prefer: "count=exact", "Range-Unit": "items", Range: "0-0" },
  });
  const range = res.headers.get("content-range") || "";
  const total = Number(range.split("/")[1]);
  return Number.isFinite(total) ? total : 0;
}

async function* pagesOlderThan(table) {
  let lastId = null;
  for (;;) {
    const cursor = lastId ? `&id=gt.${lastId}` : "";
    const res = await request(LIVE, `${table}?select=*&timestamp=lt.${CUTOFF_MS}&order=id.asc&limit=${PAGE}${cursor}`);
    const rows = await res.json();
    if (rows.length === 0) return;
    yield rows;
    if (rows.length < PAGE) return;
    lastId = rows[rows.length - 1].id;
  }
}

async function copyPage(table, conflict, rows) {
  await request(ARCHIVE, `${table}?on_conflict=${conflict}`, {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
}

async function verifyIds(table, rows) {
  const missing = [];
  for (let i = 0; i < rows.length; i += VERIFY_BATCH) {
    const ids = rows.slice(i, i + VERIFY_BATCH).map((r) => r.id);
    const res = await request(ARCHIVE, `${table}?select=id&id=in.(${ids.join(",")})`);
    const found = new Set((await res.json()).map((r) => r.id));
    for (const id of ids) if (!found.has(id)) missing.push(id);
  }
  return missing;
}

async function archiveTable({ name, conflict }) {
  const liveBefore = await countOlderThan(LIVE, name);
  console.log(`[${name}] ${liveBefore} live rows older than ${new Date(CUTOFF_MS).toISOString()}`);
  let copied = 0;
  const missing = [];
  for await (const rows of pagesOlderThan(name)) {
    await copyPage(name, conflict, rows);
    missing.push(...(await verifyIds(name, rows)));
    copied += rows.length;
    process.stdout.write(`\r[${name}] copied+verified ${copied}/${liveBefore}`);
  }
  process.stdout.write("\n");
  if (missing.length > 0) {
    throw new Error(`[${name}] ${missing.length} rows did not land in the archive; first: ${missing.slice(0, 5).join(", ")}`);
  }
  const archiveAfter = await countOlderThan(ARCHIVE, name);
  if (archiveAfter < liveBefore) {
    throw new Error(`[${name}] archive holds ${archiveAfter} rows older than cutoff but live has ${liveBefore}`);
  }
  console.log(`[${name}] OK — archive now holds ${archiveAfter} rows older than cutoff`);
  return copied;
}

async function pruneLive() {
  // prune_archived_restock_rows deletes restock_events + restock_item_events older
  // than the cutoff in bounded batches; loop until it reports nothing left.
  let total = { restock_events: 0, restock_item_events: 0 };
  for (let i = 0; i < 200; i++) {
    const res = await request(LIVE, "rpc/prune_archived_restock_rows", {
      method: "POST",
      body: JSON.stringify({ p_cutoff_ms: CUTOFF_MS, p_max_rows: 20000 }),
    });
    const r = await res.json();
    total.restock_events += r.restock_events_deleted;
    total.restock_item_events += r.restock_item_events_deleted;
    process.stdout.write(`\r[prune] restock_events ${total.restock_events}, restock_item_events ${total.restock_item_events}`);
    if (r.restock_events_deleted === 0 && r.restock_item_events_deleted === 0) break;
  }
  process.stdout.write("\n");
  return total;
}

async function recordRun(counts, deleted, note) {
  await request(ARCHIVE, "archive_runs", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      cutoff_ms: CUTOFF_MS,
      restock_events_copied: counts.restock_events,
      weather_events_copied: counts.weather_events,
      live_deleted: deleted,
      note,
    }),
  });
}

const counts = {};
for (const t of TABLES) counts[t.name] = await archiveTable(t);

if (!DELETE) {
  await recordRun(counts, false, "copy+verify only");
  console.log("Copy verified. Re-run with --delete to prune the live project.");
  process.exit(0);
}

const pruned = await pruneLive();
await recordRun(counts, true, `pruned restock_events=${pruned.restock_events} item_events=${pruned.restock_item_events}`);
const remaining = await countOlderThan(LIVE, "restock_events");
if (remaining !== 0) throw new Error(`[prune] ${remaining} restock_events older than cutoff still in live`);
console.log("Done. Live restock_events/restock_item_events now hold the last", RETENTION_DAYS, "days.");
