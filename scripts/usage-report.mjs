#!/usr/bin/env node
// Usage report from Supabase API-gateway logs: who is hitting the database, from which tool.
//
// Reads `edge_logs` through the Supabase Management API (Log Explorer backend). Nothing is
// sent by clients beyond the requests they already make; tools label themselves with the
// `x-client-info` header (qpm-gr/<ver>, restock-tracker, mgtokyo-discord-bot, gemini-server-poll).
//
//   node scripts/usage-report.mjs                # last 24h, all tables
//   node scripts/usage-report.mjs --hours 6      # shorter window (free plan retains 1 day)
//   node scripts/usage-report.mjs --hourly       # distinct IPs per hour (concurrency proxy)
//   node scripts/usage-report.mjs --paths        # per tool x path breakdown
//   node scripts/usage-report.mjs --save         # append summary to data/usage-history.jsonl
//   node scripts/usage-report.mjs --json         # raw JSON instead of tables
//
// Auth: SUPABASE_ACCESS_TOKEN env (a personal access token, sbp_...). When unset on Windows the
// script reads the token the Supabase CLI stored in Credential Manager (`supabase login`).

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HISTORY_FILE = join(ROOT, "data", "usage-history.jsonl");
const FALLBACK_PROJECT_REF = "xjuvryjgrjchbhjixwzh";
const CRED_TARGET = "Supabase CLI:supabase";

const args = parseArgs(process.argv.slice(2));
const HOURS = Number(args.hours ?? 24);
if (!Number.isFinite(HOURS) || HOURS <= 0) die("--hours must be a positive number");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function die(msg) {
  console.error(`usage-report: ${msg}`);
  process.exit(1);
}

function loadEnvFile() {
  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] in process.env) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function readCliTokenFromCredentialManager() {
  if (process.platform !== "win32") return null;
  const ps = `
$sig = @'
using System; using System.Runtime.InteropServices;
public class CredRead {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL { public uint Flags; public uint Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist; public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredReadW(string target, uint type, uint flags, out IntPtr cred);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
  public static string Read(string target) { IntPtr p; if (!CredReadW(target, 1, 0, out p)) return null; try { var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); var b = new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob, b, 0, b.Length); return System.Text.Encoding.UTF8.GetString(b); } finally { CredFree(p); } }
}
'@
Add-Type -TypeDefinition $sig
$t = [CredRead]::Read('${CRED_TARGET}')
if ($t) { [Console]::Out.Write($t) }
`;
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function resolveToken() {
  const envToken = process.env.SUPABASE_ACCESS_TOKEN;
  if (envToken) return envToken;
  const cliToken = readCliTokenFromCredentialManager();
  if (cliToken) return cliToken;
  die(
    "no access token. Set SUPABASE_ACCESS_TOKEN (create one at https://supabase.com/dashboard/account/tokens) or run `supabase login`."
  );
}

function resolveProjectRef() {
  if (process.env.SUPABASE_PROJECT_REF) return process.env.SUPABASE_PROJECT_REF;
  const refFile = join(ROOT, "supabase", ".temp", "project-ref");
  if (existsSync(refFile)) {
    const ref = readFileSync(refFile, "utf8").trim();
    if (ref) return ref;
  }
  return FALLBACK_PROJECT_REF;
}

function isoNoMillis(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function runLogQuery(token, projectRef, sql, { start, end }) {
  const url = new URL(`https://api.supabase.com/v1/projects/${projectRef}/analytics/endpoints/logs.all`);
  url.searchParams.set("sql", sql);
  url.searchParams.set("iso_timestamp_start", isoNoMillis(start));
  url.searchParams.set("iso_timestamp_end", isoNoMillis(end));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok || body.error) {
    throw new Error(`HTTP ${res.status}: ${body.error || text.slice(0, 200)}`);
  }
  return body.result ?? [];
}

// Log Explorer runs BigQuery SQL. `edge_logs` is the API gateway; headers are nested under
// metadata.request.headers. Preflights and Grafana's metrics scrape are excluded.
const BASE_FROM = `
from edge_logs
cross join unnest(metadata) as m
cross join unnest(m.request) as r
cross join unnest(r.headers) as h
cross join unnest(m.response) as resp
where r.method != 'OPTIONS'
  and (r.path like '/rest/v1/%' or r.path like '/functions/v1/%')`;

// Requests without a label are grouped by how they arrived so old clients still show up.
const TOOL_EXPR = `
coalesce(
  case
    when h.x_client_info like 'supabase-js/%runtime=deno%' then 'edge-functions (cron: restock-poll, weather-events)'
    else h.x_client_info
  end,
  case
    when h.referer like 'https://magicgarden.gg/%' then 'unlabeled: browser @ magicgarden.gg'
    when h.referer like 'https://mg-tokyo.github.io/%' then 'unlabeled: browser @ mg-tokyo.github.io'
    when h.referer like 'https://ryandt2305-cpu.github.io/%' then 'unlabeled: browser @ ryandt2305-cpu.github.io'
    when h.referer is not null then concat('unlabeled: browser @ ', h.referer)
    when h.user_agent like 'Mozilla/%' then 'unlabeled: userscript (GM_xmlhttpRequest)'
    when h.user_agent is not null then concat('unlabeled: ', substr(h.user_agent, 1, 40))
    else 'unlabeled: unknown'
  end
)`;

const SQL_BY_TOOL = `
select ${TOOL_EXPR} as tool,
  count(distinct h.cf_connecting_ip) as ips,
  count(distinct concat(h.cf_connecting_ip, '|', coalesce(h.user_agent, ''))) as ip_ua,
  count(*) as requests,
  countif(resp.status_code >= 400) as errors
${BASE_FROM}
group by 1
order by ips desc, requests desc
limit 50`;

const SQL_BY_TOOL_PATH = `
select ${TOOL_EXPR} as tool, r.method as method, r.path as path,
  count(distinct h.cf_connecting_ip) as ips,
  count(*) as requests,
  countif(resp.status_code >= 400) as errors
${BASE_FROM}
group by 1, 2, 3
order by 1, ips desc, requests desc
limit 200`;

const SQL_HOURLY = `
select timestamp_trunc(timestamp, hour) as hour_us, ${TOOL_EXPR} as tool,
  count(distinct h.cf_connecting_ip) as ips,
  count(*) as requests
${BASE_FROM}
group by 1, 2
order by 1 desc, ips desc
limit 500`;

function fmtTable(rows, columns) {
  if (rows.length === 0) return "(no rows)";
  const widths = columns.map((c) => Math.max(c.label.length, ...rows.map((r) => String(c.get(r)).length)));
  const line = (cells) => cells.map((v, i) => (columns[i].right ? String(v).padStart(widths[i]) : String(v).padEnd(widths[i]))).join("  ");
  const out = [line(columns.map((c) => c.label)), line(widths.map((w) => "-".repeat(w)))];
  for (const r of rows) out.push(line(columns.map((c) => c.get(r))));
  return out.join("\n");
}

function hourLabel(us) {
  return new Date(Number(us) / 1000).toISOString().slice(0, 13) + ":00Z";
}

async function main() {
  loadEnvFile();
  const token = resolveToken();
  const projectRef = resolveProjectRef();
  const end = new Date();
  const start = new Date(end.getTime() - HOURS * 3600 * 1000);
  const window = { start, end };

  const byTool = await runLogQuery(token, projectRef, SQL_BY_TOOL, window);
  const byToolPath = args.paths ? await runLogQuery(token, projectRef, SQL_BY_TOOL_PATH, window) : null;
  const hourly = args.hourly ? await runLogQuery(token, projectRef, SQL_HOURLY, window) : null;

  const summary = {
    generatedAt: end.toISOString(),
    windowHours: HOURS,
    projectRef,
    tools: byTool.map((r) => ({
      tool: r.tool,
      ips: Number(r.ips),
      ipUa: Number(r.ip_ua),
      requests: Number(r.requests),
      errors: Number(r.errors),
    })),
  };

  if (args.save) {
    mkdirSync(dirname(HISTORY_FILE), { recursive: true });
    appendFileSync(HISTORY_FILE, JSON.stringify(summary) + "\n");
  }

  if (args.json) {
    console.log(JSON.stringify({ ...summary, byToolPath, hourly }, null, 2));
    return;
  }

  console.log(`Supabase usage for project ${projectRef}, last ${HOURS}h (${isoNoMillis(start)} to ${isoNoMillis(end)})`);
  console.log("ips = distinct client IPs (approx. people); ip_ua = distinct IP + browser pairs; OPTIONS preflights excluded\n");
  console.log(
    fmtTable(byTool, [
      { label: "tool", get: (r) => r.tool },
      { label: "ips", get: (r) => r.ips, right: true },
      { label: "ip_ua", get: (r) => r.ip_ua, right: true },
      { label: "requests", get: (r) => r.requests, right: true },
      { label: "errors", get: (r) => r.errors, right: true },
    ])
  );

  if (byToolPath) {
    console.log("\nPer tool and path:\n");
    console.log(
      fmtTable(byToolPath, [
        { label: "tool", get: (r) => r.tool },
        { label: "method", get: (r) => r.method },
        { label: "path", get: (r) => r.path },
        { label: "ips", get: (r) => r.ips, right: true },
        { label: "requests", get: (r) => r.requests, right: true },
        { label: "errors", get: (r) => r.errors, right: true },
      ])
    );
  }

  if (hourly) {
    console.log("\nDistinct IPs per hour (UTC):\n");
    console.log(
      fmtTable(hourly, [
        { label: "hour", get: (r) => hourLabel(r.hour_us) },
        { label: "tool", get: (r) => r.tool },
        { label: "ips", get: (r) => r.ips, right: true },
        { label: "requests", get: (r) => r.requests, right: true },
      ])
    );
  }

  if (args.save) console.log(`\nAppended summary to ${HISTORY_FILE}`);
}

main().catch((err) => die(err.message));
