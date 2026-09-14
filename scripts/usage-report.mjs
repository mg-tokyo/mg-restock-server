#!/usr/bin/env node
// Usage report from Supabase API-gateway logs: who is hitting the database, from which tool.
//
// Reads `edge_logs` through the Supabase Management API (Log Explorer backend). Nothing is
// sent by clients beyond the requests they already make; tools label themselves with the
// `x-client-info` header (qpm-gr/<ver>, restock-tracker, mgtokyo-discord-bot, edge-fn/*, ...).
//
//   node scripts/usage-report.mjs                # last 24h
//   node scripts/usage-report.mjs --hours 6      # shorter window (free plan retains 1 day)
//   node scripts/usage-report.mjs --hourly       # distinct IPs per hour (concurrency proxy)
//   node scripts/usage-report.mjs --paths        # per tool x path breakdown
//   node scripts/usage-report.mjs --save         # append summary to data/usage-history.jsonl
//   node scripts/usage-report.mjs --json         # raw JSON instead of tables
//   node scripts/usage-report.mjs --no-color
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

const COLOR = !args["no-color"] && !process.env.NO_COLOR && process.stdout.isTTY;
const c = {
  bold: (s) => (COLOR ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s),
  green: (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (COLOR ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s),
  cyan: (s) => (COLOR ? `\x1b[36m${s}\x1b[0m` : s),
};

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

async function runLogQuery(token, projectRef, sql, { start, end }, attempt = 1) {
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
    // The log backend fails intermittently with "Backend error! Retry your query."
    if (attempt < 3 && /backend error/i.test(String(body.error ?? ""))) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      return runLogQuery(token, projectRef, sql, { start, end }, attempt + 1);
    }
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
// supabase-js may send its default label joined with ours ("supabase-js/..., edge-fn/x").
const TOOL_EXPR = `
coalesce(
  case
    when h.x_client_info like '%, %' then regexp_extract(h.x_client_info, r', ([^,]+)$')
    when h.x_client_info like 'supabase-js/%runtime=deno%' then 'edge-functions (default label)'
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

// One row per tool x IP; the people totals are computed in JS from this (the log backend
// rejects CTEs and IN-subqueries).
const SQL_TOOL_IPS = `
select ${TOOL_EXPR} as tool, h.cf_connecting_ip as ip, count(*) as requests
${BASE_FROM}
group by 1, 2
limit 20000`;

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

// Presentation: same predicates as the SQL, applied to the label for grouping and naming.
const USER_LABELS = [
  [/^qpm-gr\//, (t) => `QPM  ${t.slice("qpm-gr/".length)}`],
  [/^unlabeled: userscript/, () => "QPM  (older build, userscript)"],
  [/^unlabeled: browser @ magicgarden\.gg/, () => "QPM  (older build, browser fetch)"],
  [/^restock-tracker/, () => "restock-tracker"],
  [/^unlabeled: browser @ (mg-tokyo|ryandt2305-cpu)\.github\.io/, () => "restock-tracker  (older build)"],
];
const INFRA_LABELS = [
  [/^edge-fn\//, (t) => `edge function  ${t.slice("edge-fn/".length)}`],
  [/^edge-functions/, () => "edge functions  (default label, pre-deploy)"],
  [/^gh-actions\//, (t) => `GitHub Actions  ${t.slice("gh-actions/".length)}`],
  [/^gemini-server-poll/, () => "GitHub Actions  poll-weather (node)"],
  [/^unlabeled: node$/, () => "GitHub Actions  poll-weather (older build)"],
  [/^mgtokyo-discord-bot/, () => "Discord bot"],
  [/^unlabeled: curl\//, (t) => `curl  ${t.slice("unlabeled: curl/".length)}`],
];

function classify(tool) {
  for (const [re, name] of USER_LABELS) if (re.test(tool)) return { group: "users", name: name(tool) };
  for (const [re, name] of INFRA_LABELS) if (re.test(tool)) return { group: "infra", name: name(tool) };
  return { group: "other", name: tool.replace(/^unlabeled: /, "") };
}

// People = distinct IPs across user-facing tools only. Infra rows (edge functions, pollers,
// workflow curl, the bot, probes) are excluded; one person using two tools counts once.
function computePeople(toolIpRows) {
  const qpm = new Set();
  const tracker = new Set();
  let requests = 0;
  for (const r of toolIpRows) {
    const { group, name } = classify(r.tool);
    if (group !== "users") continue;
    (name.startsWith("QPM") ? qpm : tracker).add(r.ip);
    requests += Number(r.requests);
  }
  const both = [...qpm].filter((ip) => tracker.has(ip)).length;
  return { people: qpm.size + tracker.size - both, qpm: qpm.size, tracker: tracker.size, both, requests };
}

function n(v) {
  return Number(v).toLocaleString("en-US");
}

function fmtTable(rows, columns, indent = "  ") {
  if (rows.length === 0) return `${indent}${c.dim("(none)")}`;
  const cells = rows.map((r) => columns.map((col) => String(col.get(r))));
  const widths = columns.map((col, i) => Math.max(col.label.length, ...cells.map((row) => row[i].length)));
  const line = (vals, paint) =>
    indent +
    vals
      .map((v, i) => {
        const padded = columns[i].right ? v.padStart(widths[i]) : v.padEnd(widths[i]);
        return paint ? paint(padded, i, v) : padded;
      })
      .join("   ");
  const out = [c.dim(line(columns.map((col) => col.label)))];
  cells.forEach((row, ri) => {
    out.push(
      line(row, (padded, i) => {
        const col = columns[i];
        if (col.paint) return col.paint(padded, rows[ri]);
        return padded;
      })
    );
  });
  return out.join("\n");
}

const paintErrors = (padded, row) => {
  const e = Number(row.errors);
  if (e === 0) return c.dim(padded);
  const ratio = e / Math.max(1, Number(row.requests));
  return ratio >= 0.25 ? c.red(padded) : c.yellow(padded);
};

function hourLabel(us) {
  return new Date(Number(us) / 1000).toISOString().slice(0, 13) + ":00Z";
}

function fmtWindow(start, end) {
  const f = (d) => d.toISOString().slice(0, 16).replace("T", " ");
  return `${f(start)} → ${f(end)} UTC`;
}

function section(title) {
  console.log(`\n${c.bold(c.cyan(title))}`);
}

async function main() {
  loadEnvFile();
  const token = resolveToken();
  const projectRef = resolveProjectRef();
  const end = new Date();
  const start = new Date(end.getTime() - HOURS * 3600 * 1000);
  const window = { start, end };

  const [byTool, toolIps] = await Promise.all([
    runLogQuery(token, projectRef, SQL_BY_TOOL, window),
    runLogQuery(token, projectRef, SQL_TOOL_IPS, window),
  ]);
  const totals = computePeople(toolIps);
  const byToolPath = args.paths ? await runLogQuery(token, projectRef, SQL_BY_TOOL_PATH, window) : null;
  const hourly = args.hourly ? await runLogQuery(token, projectRef, SQL_HOURLY, window) : null;

  const summary = {
    generatedAt: end.toISOString(),
    windowHours: HOURS,
    projectRef,
    people: totals.people,
    qpmPeople: totals.qpm,
    trackerPeople: totals.tracker,
    bothTools: totals.both,
    userRequests: totals.requests,
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

  const windowLabel = HOURS === 24 ? "last 24 hours" : HOURS < 1 ? `last ${Math.round(HOURS * 60)} min` : `last ${HOURS} hours`;
  console.log(`\n${c.bold("Supabase usage")}  ${c.dim(`${projectRef} · ${windowLabel} · ${fmtWindow(start, end)}`)}`);

  console.log(`\n  ${c.bold(c.green(n(summary.people)))} ${c.bold("people")}   ${c.dim("distinct IPs across QPM + restock-tracker")}`);
  console.log(
    `  ${c.dim("QPM")} ${n(summary.qpmPeople)}   ${c.dim("restock-tracker")} ${n(summary.trackerPeople)}   ${c.dim("both")} ${n(summary.bothTools)}   ${c.dim("requests")} ${n(summary.userRequests)}`
  );

  const grouped = { users: [], infra: [], other: [] };
  for (const r of byTool) {
    const { group, name } = classify(r.tool);
    grouped[group].push({ ...r, name });
  }
  const toolColumns = [
    { label: "tool", get: (r) => r.name },
    { label: "people", get: (r) => n(r.ips), right: true },
    { label: "ip+browser", get: (r) => n(r.ip_ua), right: true },
    { label: "requests", get: (r) => n(r.requests), right: true },
    { label: "errors", get: (r) => n(r.errors), right: true, paint: paintErrors },
  ];

  section("Users");
  console.log(fmtTable(grouped.users, toolColumns));
  section("Infra");
  console.log(fmtTable(grouped.infra, [{ ...toolColumns[0] }, { ...toolColumns[1], label: "ips" }, ...toolColumns.slice(2)]));
  if (grouped.other.length) {
    section("Other");
    console.log(fmtTable(grouped.other, [{ ...toolColumns[0] }, { ...toolColumns[1], label: "ips" }, ...toolColumns.slice(2)]));
  }

  if (byToolPath) {
    section("Per tool and path");
    console.log(
      fmtTable(
        byToolPath.map((r) => ({ ...r, name: classify(r.tool).name })),
        [
          { label: "tool", get: (r) => r.name },
          { label: "method", get: (r) => r.method },
          { label: "path", get: (r) => r.path.replace(/^\/rest\/v1\//, "").replace(/^\/functions\/v1\//, "fn:") },
          { label: "ips", get: (r) => n(r.ips), right: true },
          { label: "requests", get: (r) => n(r.requests), right: true },
          { label: "errors", get: (r) => n(r.errors), right: true, paint: paintErrors },
        ]
      )
    );
  }

  if (hourly) {
    section("Distinct IPs per hour (UTC)");
    console.log(
      fmtTable(
        hourly.map((r) => ({ ...r, name: classify(r.tool).name })),
        [
          { label: "hour", get: (r) => hourLabel(r.hour_us) },
          { label: "tool", get: (r) => r.name },
          { label: "ips", get: (r) => n(r.ips), right: true },
          { label: "requests", get: (r) => n(r.requests), right: true },
        ]
      )
    );
  }

  console.log(
    `\n${c.dim("people = distinct client IPs (shared households/VPNs undercount). Preflights excluded. Older builds are grouped until users update.")}`
  );
  if (args.save) console.log(c.dim(`Appended summary to ${HISTORY_FILE}`));
  console.log();
}

main().catch((err) => die(err.message));
