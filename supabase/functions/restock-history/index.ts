import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { checkRateLimit, rateLimitHeaders } from "../_shared/rateLimit.ts";

const SUPABASE_URL =
  Deno.env.get("SVC_SUPABASE_URL") ??
  Deno.env.get("SUPABASE_URL") ??
  "";
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SVC_SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  "";

/** Only the columns the client actually uses. */
const HISTORY_COLUMNS = [
  "item_id",
  "shop_type",
  "total_occurrences",
  "total_quantity",
  "first_seen",
  "last_seen",
  "average_interval_ms",
  "estimated_next_timestamp",
  "average_quantity",
  "last_quantity",
  "rate_per_day",
  "appearance_rate",
].join(",");

function ok(
  data: Record<string, unknown>,
  req: Request,
  etag?: string,
  rateLimit?: Record<string, string>
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...corsHeaders(req),
    // Cache headers
    "cache-control": "public, max-age=60, stale-while-revalidate=300",
    // Security headers
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    ...(rateLimit || {}),
  };
  if (etag) headers["etag"] = etag;
  return new Response(JSON.stringify(data), { status: 200, headers });
}

function bad(message: string, status: number, req: Request) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(req) },
  });
}

function getClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
    // Tool label for API-log usage counts (`npm run usage`).
    global: { headers: { "x-client-info": "edge-fn/restock-history" } },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return preflight(req);
  }
  if (req.method !== "GET") {
    return bad("Method not allowed", 405, req);
  }

  // Rate limiting: 60 requests per minute per IP/origin (120 for trusted origins)
  const rateCheck = await checkRateLimit(req, {
    maxRequests: 60,
    windowMs: 60 * 1000,
    trustedMaxRequests: 120,
  });

  if (!rateCheck.allowed) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: rateCheck.message,
        retryAfter: Math.ceil((rateCheck.resetAt - Date.now()) / 1000),
      }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          ...corsHeaders(req),
          ...rateLimitHeaders(rateCheck),
          "retry-after": String(Math.ceil((rateCheck.resetAt - Date.now()) / 1000)),
        },
      }
    );
  }

  // Request validation: check for suspicious patterns
  const origin = req.headers.get("origin");
  const userAgent = req.headers.get("user-agent");

  // Log request for monitoring (optional, can be removed in production)
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    origin: origin || "no-origin",
    userAgent: userAgent?.slice(0, 100) || "unknown",
    ip: req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "unknown",
    remaining: rateCheck.remaining,
  }));

  const client = getClient();

  // Get latest event timestamp for ETag
  const { data: metaRow } = await client
    .from("restock_events")
    .select("timestamp")
    .order("timestamp", { ascending: false })
    .limit(1)
    .maybeSingle();

  const lastUpdated = metaRow?.timestamp ?? null;
  const etag = lastUpdated ? `"${lastUpdated}"` : null;

  // Check If-None-Match for 304
  const ifNoneMatch = req.headers.get("if-none-match");
  if (etag && ifNoneMatch === etag) {
    return new Response(null, {
      status: 304,
      headers: { ...corsHeaders(req), ...(etag ? { etag } : {}) },
    });
  }

  // Fetch history with only the columns the client needs
  const { data, error } = await client.from("restock_history").select(HISTORY_COLUMNS);
  if (error) return bad("Failed to fetch history", 500, req);

  const items: Record<string, unknown> = {};
  for (const row of data ?? []) {
    const key = `${row.shop_type}:${row.item_id}`;
    items[key] = {
      itemId: row.item_id,
      shopType: row.shop_type,
      totalOccurrences: row.total_occurrences,
      totalQuantity: row.total_quantity ?? null,
      firstSeen: row.first_seen ?? null,
      lastSeen: row.last_seen ?? null,
      averageIntervalMs: row.average_interval_ms ?? null,
      estimatedNextTimestamp: row.estimated_next_timestamp ?? null,
      averageQuantity: row.average_quantity ?? null,
      lastQuantity: row.last_quantity ?? null,
      ratePerDay: row.rate_per_day ?? null,
      appearanceRate: row.appearance_rate ?? null,
    };
  }

  return ok(
    {
      items,
      meta: {
        lastUpdated,
        count: Object.keys(items).length,
      },
    },
    req,
    etag ?? undefined,
    rateLimitHeaders(rateCheck)
  );
});
