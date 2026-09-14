import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { DEFAULT_PLATFORM_API_BASE, fetchPlatformWeather } from "./lib/platformApi.mjs";
// Node 20+ has native fetch; node-fetch v3 hangs on some requests (see poll.mjs).

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const STATE_FILE = path.join(DATA_DIR, "weather-state.json");

function loadEnvFile() {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!key) continue;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_REST_ENDPOINT = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1` : "";
const SUPABASE_HEADERS = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "resolution=ignore-duplicates,return=representation",
    "x-client-info": "gemini-server-poll",
  }
  : null;

// Official Magic Garden platform API (replaces mg-api.ariedam.fr /live/weather as of 2026-08).
// Reference: Feeder-Extension/docs/superpowers/specs/2026-08-16-mg-platform-api-reference.md
const PLATFORM_API_BASE = process.env.MG_PLATFORM_API_BASE || DEFAULT_PLATFORM_API_BASE;
const WEATHER_POLL_MS = Number(process.env.WEATHER_POLL_MS || 60000);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 15000);
const WEATHER_ONE_SHOT = process.env.WEATHER_ONE_SHOT
  ? process.env.WEATHER_ONE_SHOT !== "0"
  : process.env.GITHUB_ACTIONS === "true";

/** Data-lineage tag written to weather_events.source. Was "mg-api" before 2026-08. */
const EVENT_SOURCE = "platform-api";

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/**
 * The official /weather payload is `null` when no event is active. When an event
 * is active it is an object whose exact shape is not yet pinned; if it carries a
 * timestamp-like field we use it, otherwise "now".
 */
function extractTimestamp(payload) {
  if (!payload || typeof payload !== "object") return Date.now();
  const raw =
    payload.timestamp ??
    payload.ts ??
    payload.startedAt ??
    payload.started_at ??
    payload.updatedAt ??
    payload.updated_at ??
    payload.time ??
    null;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const ms = Date.parse(String(raw || ""));
  return Number.isFinite(ms) ? ms : Date.now();
}

function makeFingerprint(timestamp, weatherId, source) {
  return `weather:${source}:${timestamp}:${weatherId}`;
}

async function insertWeatherEvent(event) {
  if (!SUPABASE_HEADERS || !SUPABASE_REST_ENDPOINT) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  const res = await fetch(`${SUPABASE_REST_ENDPOINT}/weather_events?on_conflict=fingerprint`, {
    method: "POST",
    headers: SUPABASE_HEADERS,
    body: JSON.stringify([event]),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 409) return;
    throw new Error(`Supabase insert weather_events failed: ${res.status} ${text}`);
  }

  // Trigger rebuild of history/predictions
  const rebuildRes = await fetch(`${SUPABASE_REST_ENDPOINT}/rpc/rebuild_weather_history`, {
    method: "POST",
    headers: SUPABASE_HEADERS,
  });
  if (!rebuildRes.ok) {
    console.warn(`[WeatherPoller] Failed to rebuild history: ${rebuildRes.status}`);
  }
}

let loggedUnknownPayload = false;

async function pollLoop() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  let state = readJson(STATE_FILE, { lastWeatherId: null, lastTimestamp: null });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const { raw, weatherId } = await fetchPlatformWeather(PLATFORM_API_BASE, {
        timeoutMs: FETCH_TIMEOUT_MS,
        userAgent: "Gemini-Server/poll-weather",
      });
      const timestamp = extractTimestamp(raw);

      if (weatherId === null) {
        // Non-null payload we could not map. Do NOT record it as Sunny; log once so the shape can be pinned.
        if (!loggedUnknownPayload) {
          console.warn("[WeatherPoller] Unrecognised weather payload (pin the shape in scripts/lib/platformApi.mjs):", JSON.stringify(raw));
          loggedUnknownPayload = true;
        }
      } else if (state.lastTimestamp && timestamp <= state.lastTimestamp) {
        // no-op: same or older observation
      } else if (state.lastWeatherId !== weatherId || !state.lastTimestamp) {
        const event = {
          timestamp,
          weather_id: weatherId,
          previous_weather_id: state.lastWeatherId,
          source: EVENT_SOURCE,
          fingerprint: makeFingerprint(timestamp, weatherId, EVENT_SOURCE),
        };
        await insertWeatherEvent(event);
        state = { lastWeatherId: weatherId, lastTimestamp: timestamp };
        writeJson(STATE_FILE, state);
        console.log(`[WeatherPoller] ${weatherId} @ ${timestamp}${raw !== null ? ` raw=${JSON.stringify(raw)}` : ""}`);
      } else {
        state = { lastWeatherId: weatherId, lastTimestamp: timestamp };
        writeJson(STATE_FILE, state);
      }
    } catch (err) {
      console.error("[WeatherPoller] Error:", err?.message ?? err);
    }
    if (WEATHER_ONE_SHOT) break;
    await new Promise((resolve) => setTimeout(resolve, WEATHER_POLL_MS));
  }
}

pollLoop().catch((err) => {
  console.error(err);
  process.exit(1);
});
