/**
 * Shared CORS configuration for Edge Functions.
 *
 * Allows requests from known game origins and requests with no Origin header
 * (e.g. Tampermonkey GM_xmlhttpRequest, server-to-server, cron jobs).
 */

const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([
  "https://magiccircle.gg",
  "https://www.magiccircle.gg",
  "https://magicgarden.gg",
  "https://www.magicgarden.gg",
  "https://starweaver.org",
  "https://www.starweaver.org",
  "https://1227719606223765687.discordsays.com",
  // GitHub Pages domains for restock tracker
  "https://ryandt2305-cpu.github.io",
  "https://mg-tokyo.github.io",
  "http://localhost:8000", // Local testing
  "http://127.0.0.1:8000",
]);

/**
 * Build CORS headers for a given request.
 * - If the request has a recognised Origin, echo it back.
 * - If the request has no Origin (GM_xmlhttpRequest / server), allow through.
 * - If the request has an unknown Origin, omit allow-origin so the browser blocks it.
 */
export function corsHeaders(req: Request, allowMethods = "GET, OPTIONS"): Record<string, string> {
  const origin = req.headers.get("origin");
  const headers: Record<string, string> = {
    "access-control-allow-headers":
      "authorization, x-client-info, x-poll-secret, apikey, content-type, if-none-match",
    "access-control-allow-methods": allowMethods,
    "access-control-max-age": "86400",
  };

  if (!origin) {
    // No Origin header: non-browser or GM_xmlhttpRequest — allow
    headers["access-control-allow-origin"] = "*";
  } else if (ALLOWED_ORIGINS.has(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["vary"] = "Origin";
  }
  // Unknown origin: omit allow-origin → browser will block the response

  return headers;
}

/** Standard OPTIONS preflight response. */
export function preflight(req: Request, allowMethods = "GET, OPTIONS"): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(req, allowMethods),
  });
}
