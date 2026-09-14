import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import {
  DEFAULT_PLATFORM_API_BASE,
  fetchPlatformShops,
  fetchPlatformWeather,
  isPreRestockStale,
} from "../_shared/platformApi.ts";

const SUPABASE_URL =
  Deno.env.get("SVC_SUPABASE_URL") ??
  Deno.env.get("SUPABASE_URL") ??
  "";
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SVC_SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  "";
const POLL_SECRET = Deno.env.get("POLL_SECRET") ?? "";

// Official Magic Garden platform API (replaces mg-api.ariedam.fr /live as of 2026-08).
// Reference: Feeder-Extension/docs/superpowers/specs/2026-08-16-mg-platform-api-reference.md
const PLATFORM_API_BASE = Deno.env.get("MG_PLATFORM_API_BASE") ?? DEFAULT_PLATFORM_API_BASE;
const FETCH_TIMEOUT_MS = Number(Deno.env.get("FETCH_TIMEOUT_MS") ?? 15000);
// If the cron fires exactly on a restock boundary the API may still return the
// pre-restock snapshot (nextRestockAt <= now). Refetch a bounded number of times.
const STALE_RETRIES = Number(Deno.env.get("STALE_RETRIES") ?? 3);
const STALE_DELAY_MS = Number(Deno.env.get("STALE_DELAY_MS") ?? 2000);

/** Data-lineage tag written to restock_events.source. Was "mg-api" before 2026-08. */
const EVENT_SOURCE = "platform-api";

type RegistryEntry = {
  shop_type: string;
  cycle_interval_ms: number;
  config: Record<string, unknown>;
};

const VALID_WEATHER_IDS: ReadonlySet<string> = new Set([
  "Sunny", "Rain", "Dawn", "Frost", "Snow", "AmberMoon", "Thunderstorm",
]);

// Weather events are snapped to 5-minute slots (matching Rain's event duration).
const WEATHER_SNAP_INTERVAL = 300_000;

function snapTimestamp(intervalMs: number, ts: number): number {
  return Math.floor(ts / intervalMs) * intervalMs;
}

/** Round cycle estimate up to nearest minute boundary (min 60s). */
function roundToMinuteBoundary(ms: number): number {
  const minute = 60_000;
  return Math.max(minute, Math.ceil(ms / minute) * minute);
}

async function fetchRegistry(client: ReturnType<typeof getClient>): Promise<Map<string, RegistryEntry>> {
  const { data, error } = await client
    .from("shop_type_registry")
    .select("shop_type, cycle_interval_ms, config")
    .eq("is_active", true);

  if (error) {
    console.error("Failed to fetch shop_type_registry:", error.message);
    return new Map();
  }

  const map = new Map<string, RegistryEntry>();
  for (const row of data ?? []) {
    map.set(row.shop_type, row as RegistryEntry);
  }
  return map;
}

function makeFingerprint(shopType: string, snappedTs: number, items: { itemId: string; stock: number }[]): string {
  const parts = items
    .map((item) => `${item.itemId}:${item.stock}`)
    .sort()
    .join("|");
  return `${shopType}:${snappedTs}:${parts}`;
}

function makeWeatherFingerprint(snappedTs: number, weatherId: string): string {
  return `weather:restock:${snappedTs}:${weatherId}`;
}

function getClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
    // Tool label for API-log usage counts (`npm run usage`).
    global: { headers: { "x-client-info": "edge-fn/restock-poll" } },
  });
}

function json(data: unknown, status: number, req: Request): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(req, "POST, OPTIONS") },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return preflight(req, "POST, OPTIONS");
  }

  // Authenticate: require x-poll-secret header (or Authorization Bearer matching POLL_SECRET)
  if (POLL_SECRET) {
    const secret = req.headers.get("x-poll-secret") ?? "";
    const authHeader = req.headers.get("authorization") ?? "";
    const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (secret !== POLL_SECRET && bearerToken !== POLL_SECRET) {
      return json({ ok: false, error: "Unauthorized" }, 403, req);
    }
  }

  try {
    // ── Fetch official platform API (shops + weather in parallel) ─────────
    const fetchOpts = { timeoutMs: FETCH_TIMEOUT_MS, userAgent: "Gemini-Server/restock-poll" };
    const [shopsResult, weatherResult] = await Promise.all([
      fetchPlatformShops(PLATFORM_API_BASE, {
        ...fetchOpts,
        staleRetries: STALE_RETRIES,
        staleDelayMs: STALE_DELAY_MS,
      }),
      fetchPlatformWeather(PLATFORM_API_BASE, fetchOpts).catch((err) => {
        // Weather is optional enrichment; never fail the shop poll because of it.
        console.error("Weather fetch failed:", err instanceof Error ? err.message : String(err));
        return { raw: null, weatherId: null as string | null, failed: true };
      }),
    ]);

    const shops = shopsResult.shops;
    // `now` must be taken AFTER the (possibly retried) fetch so snapping lands in the new cycle.
    const now = Date.now();
    const stillStale = isPreRestockStale(shops, now);
    if (stillStale) {
      console.warn(`Shops snapshot still pre-restock after ${shopsResult.staleRetries} retries; recording anyway.`);
    }

    // null payload => "Sunny" (documented). Unrecognised payload => null (skip weather, log raw once).
    const weatherId = weatherResult.weatherId;
    if (weatherId === null && weatherResult.raw !== null && weatherResult.raw !== undefined) {
      console.warn("Unrecognised weather payload (pin the shape in platformApi.ts):", JSON.stringify(weatherResult.raw));
    }

    const client = getClient();
    const inserted: string[] = [];
    const skipped: string[] = [];
    const registered: string[] = [];

    // ── Registry lookup ─────────────────────────────────────────────────
    const registry = await fetchRegistry(client);

    // ── Shop inventory ────────────────────────────────────────────────────
    // Iterate ALL shop keys from the API, not a hardcoded list.
    for (const shopType of Object.keys(shops)) {
      const shopData = shops[shopType];
      // Closed (weather-gated / event) shops report open:false with empty items.
      if (!shopData || !shopData.open || shopData.items.length === 0) {
        skipped.push(shopType);
        continue;
      }

      // Auto-register unknown shop types using time-until-restock as cycle estimate
      let entry = registry.get(shopType);
      if (!entry) {
        const estimatedMs = shopData.secondsUntilRestock > 0
          ? roundToMinuteBoundary(shopData.secondsUntilRestock * 1000)
          : 300_000;
        const { error: regErr } = await client.rpc("register_shop_type", {
          p_shop_type: shopType,
          p_cycle_interval_ms: estimatedMs,
          p_discovered_from: "restock-poll-auto",
        });
        if (regErr) {
          console.error(`Failed to register shop type "${shopType}":`, regErr.message);
          skipped.push(shopType);
          continue;
        }
        entry = { shop_type: shopType, cycle_interval_ms: estimatedMs, config: {} };
        registry.set(shopType, entry);
        registered.push(shopType);
      }

      const intervalMs = entry.cycle_interval_ms;
      const snappedTs = snapTimestamp(intervalMs, now);

      // platformApi already dropped stock<=0; keep the explicit filter as a guard.
      const items = shopData.items
        .filter((item) => item.itemId && item.stock > 0)
        .map((item) => ({ itemId: item.itemId, stock: item.stock }));

      if (items.length === 0) {
        skipped.push(shopType);
        continue;
      }

      const fingerprint = makeFingerprint(shopType, snappedTs, items);

      const { data: insertData, error: insertErr } = await client
        .from("restock_events")
        .insert({
          timestamp: snappedTs,
          shop_type: shopType,
          items: items,
          source: EVENT_SOURCE,
          fingerprint,
          weather_id: weatherId ?? null,
        })
        .select("id")
        .maybeSingle();

      if (insertErr) {
        if (insertErr.code === "23505") {
          skipped.push(shopType);
          continue;
        }
        console.error(`Insert error for ${shopType}:`, insertErr.message);
        skipped.push(shopType);
        continue;
      }

      if (!insertData) {
        skipped.push(shopType);
        continue;
      }

      // For egg shops, pass 5-minute resolution so ingest_restock_history
      // can distinguish weather-locked egg restocks (SnowEgg, DawnEgg)
      // that happen every 5 min. Non-weather-locked eggs are re-snapped
      // to 15 min inside the function via restock_item_snap_timestamp.
      const ingestTs = shopType === "egg"
        ? Math.floor(now / 300_000) * 300_000
        : snappedTs;

      const { error: historyErr } = await client.rpc("ingest_restock_history", {
        p_shop_type: shopType,
        p_ts: ingestTs,
        p_items: items,
        p_weather_id: weatherId ?? null,
      });

      if (historyErr) {
        console.error(`History ingest error for ${shopType}:`, historyErr.message);
      }

      inserted.push(shopType);
    }

    // ── Weather recording ─────────────────────────────────────────────────
    // Insert one weather event per 5-minute slot. Fingerprint deduplication
    // prevents duplicates if the same weather is polled multiple times in a slot.
    // After any new insert, rebuild weather_history so weather_predictions stays fresh.
    let weatherInserted = false;

    if (weatherId && VALID_WEATHER_IDS.has(weatherId)) {
      const weatherSnappedTs = Math.floor(now / WEATHER_SNAP_INTERVAL) * WEATHER_SNAP_INTERVAL;
      const weatherFingerprint = makeWeatherFingerprint(weatherSnappedTs, weatherId);

      const { error: weatherErr } = await client.from("weather_events").insert({
        timestamp: weatherSnappedTs,
        weather_id: weatherId,
        previous_weather_id: null,
        source: "restock",
        fingerprint: weatherFingerprint,
      });

      if (weatherErr && weatherErr.code !== "23505") {
        console.error("Weather insert error:", weatherErr.message);
      } else if (!weatherErr) {
        // New event inserted — rebuild weather_history to keep predictions fresh.
        weatherInserted = true;
        const { error: rebuildErr } = await client.rpc("rebuild_weather_history");
        if (rebuildErr) {
          console.error("Weather history rebuild error:", rebuildErr.message);
        }
      }
    }

    return json({
      ok: true,
      source: EVENT_SOURCE,
      inserted,
      skipped,
      registered,
      timestamp: now,
      shops: {
        staleRetries: shopsResult.staleRetries,
        stillStale,
        nextRestockAt: Object.fromEntries(
          Object.entries(shops).map(([k, v]) => [k, v.nextRestockAtIso]),
        ),
      },
      weather: { id: weatherId, raw: weatherResult.raw, inserted: weatherInserted },
    }, 200, req);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: message }, 500, req);
  }
});
