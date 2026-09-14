import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";

const SUPABASE_URL =
  Deno.env.get("SVC_SUPABASE_URL") ??
  Deno.env.get("SUPABASE_URL") ??
  "";
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SVC_SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  "";

const VALID_WEATHER_IDS: ReadonlySet<string> = new Set([
  "Sunny",
  "Rain",
  "Dawn",
  "Frost",
  "Snow",
  "AmberMoon",
  "Thunderstorm",
]);

const VALID_SOURCES: ReadonlySet<string> = new Set([
  "client",
  "restock",
  "discord-json",
  "magicshopkeeper",
]);

/** Maximum age/future drift for timestamps (24 hours). */
const TIMESTAMP_DRIFT_MS = 86_400_000;

const ALLOW_METHODS = "GET, POST, OPTIONS";

/** Columns the GET endpoint returns (no internal fields like fingerprint). */
const EVENT_COLUMNS = "timestamp,weather_id,previous_weather_id,source";
const SUMMARY_COLUMNS = "timestamp,weather_id,previous_weather_id,source";

function ok(data: Record<string, unknown>, req: Request) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json", ...corsHeaders(req, ALLOW_METHODS) },
  });
}

function bad(message: string, status: number, req: Request) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(req, ALLOW_METHODS) },
  });
}

function getClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
    // Tool label for API-log usage counts (`npm run usage`).
    global: { headers: { "X-Client-Info": "edge-fn/weather-events" } },
  });
}

function makeFingerprint(timestamp: number, weatherId: string, source: string) {
  return `weather:${source}:${timestamp}:${weatherId}`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return preflight(req, ALLOW_METHODS);
  }

  const client = getClient();

  // ── POST: submit a weather event ──────────────────────────────────────
  if (req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return bad("Invalid body", 400, req);

    const weatherId = String(body.weatherId ?? body.weather_id ?? "");
    const timestamp = Number(body.timestamp ?? 0);

    if (!weatherId || !Number.isFinite(timestamp) || timestamp <= 0) {
      return bad("Missing weatherId or timestamp", 400, req);
    }

    // Validate weather_id against known set
    if (!VALID_WEATHER_IDS.has(weatherId)) {
      return bad(`Unknown weatherId: ${weatherId}`, 400, req);
    }

    // Validate timestamp is within reasonable range (not too old or far future)
    const now = Date.now();
    if (Math.abs(now - timestamp) > TIMESTAMP_DRIFT_MS) {
      return bad("Timestamp too far from current time", 400, req);
    }

    // Validate source
    const source = String(body.source ?? "client");
    if (!VALID_SOURCES.has(source)) {
      return bad(`Unknown source: ${source}`, 400, req);
    }

    const previousWeatherId = body.previousWeatherId ?? body.previous_weather_id ?? null;
    if (previousWeatherId != null && !VALID_WEATHER_IDS.has(String(previousWeatherId))) {
      return bad(`Unknown previousWeatherId: ${previousWeatherId}`, 400, req);
    }

    // Server-side fingerprint — ignore any client-supplied value
    const fingerprint = makeFingerprint(timestamp, weatherId, source);

    const { error } = await client.from("weather_events").insert({
      timestamp,
      weather_id: weatherId,
      previous_weather_id: previousWeatherId ? String(previousWeatherId) : null,
      source,
      fingerprint,
    });

    if (error) {
      // Unique constraint = duplicate, treat as success
      if (error.code === "23505") {
        return ok({ ok: true, duplicate: true }, req);
      }
      return bad("Failed to insert weather event", 500, req);
    }

    return ok({ ok: true }, req);
  }

  // ── GET: fetch weather history ────────────────────────────────────────
  if (req.method !== "GET") {
    return bad("Method not allowed", 405, req);
  }

  const url = new URL(req.url);
  const since = Number(url.searchParams.get("since") ?? 0);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 500);

  const useSummary = (url.searchParams.get("summary") ?? "1") !== "0";
  let query = client
    .from(useSummary ? "weather_summary" : "weather_events")
    .select(useSummary ? SUMMARY_COLUMNS : EVENT_COLUMNS)
    .order("timestamp", { ascending: false })
    .limit(limit);
  if (Number.isFinite(since) && since > 0) {
    query = query.gt("timestamp", since);
  }

  let { data, error } = await query;
  if (error) return bad("Failed to fetch weather events", 500, req);

  // Fallback to raw events if summary is empty
  if (useSummary && (!data || data.length === 0)) {
    let fallback = client
      .from("weather_events")
      .select(EVENT_COLUMNS)
      .order("timestamp", { ascending: false })
      .limit(limit);
    if (Number.isFinite(since) && since > 0) {
      fallback = fallback.gt("timestamp", since);
    }
    const fallbackRes = await fallback;
    if (!fallbackRes.error && Array.isArray(fallbackRes.data)) {
      data = fallbackRes.data;
    }
  }

  // Derive convenience "last seen" timestamps for known weather types
  let lastRainStart: number | null = null;
  let lastRainEnd: number | null = null;
  let lastDawnStart: number | null = null;
  let lastDawnEnd: number | null = null;
  let lastFrostStart: number | null = null;
  let lastAmberMoonStart: number | null = null;

  for (const row of data ?? []) {
    const wId = row.weather_id as string;
    const prevId = row.previous_weather_id as string | null;
    const ts = row.timestamp as number;

    if (wId === "Rain" && (lastRainStart == null || ts > lastRainStart)) {
      lastRainStart = ts;
    }
    if (prevId === "Rain" && wId !== "Rain" && (lastRainEnd == null || ts > lastRainEnd)) {
      lastRainEnd = ts;
    }
    if (wId === "Dawn" && (lastDawnStart == null || ts > lastDawnStart)) {
      lastDawnStart = ts;
    }
    if (prevId === "Dawn" && wId !== "Dawn" && (lastDawnEnd == null || ts > lastDawnEnd)) {
      lastDawnEnd = ts;
    }
    if ((wId === "Frost" || wId === "Snow") && (lastFrostStart == null || ts > lastFrostStart)) {
      lastFrostStart = ts;
    }
    if (wId === "AmberMoon" && (lastAmberMoonStart == null || ts > lastAmberMoonStart)) {
      lastAmberMoonStart = ts;
    }
  }

  return ok({
    events: data ?? [],
    meta: {
      lastRainStart,
      lastRainEnd,
      lastDawnStart,
      lastDawnEnd,
      lastFrostStart,
      lastAmberMoonStart,
    },
  }, req);
});
