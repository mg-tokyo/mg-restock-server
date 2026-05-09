/**
 * Rate limiting for Edge Functions using Deno KV
 *
 * Provides IP-based and origin-based rate limiting with sliding window algorithm.
 */

interface RateLimitConfig {
  /** Maximum requests allowed in the window */
  maxRequests: number;
  /** Time window in milliseconds */
  windowMs: number;
  /** Optional: different limit for known origins */
  trustedMaxRequests?: number;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  message?: string;
}

/**
 * Check if a request should be rate limited
 */
export async function checkRateLimit(
  req: Request,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const identifier = getIdentifier(req);
  const origin = req.headers.get("origin");
  const isTrusted = isTrustedOrigin(origin);

  // Use higher limit for trusted origins
  const maxRequests = isTrusted && config.trustedMaxRequests
    ? config.trustedMaxRequests
    : config.maxRequests;

  try {
    const kv = await Deno.openKv();
    const key = ["rate_limit", identifier];
    const now = Date.now();
    const windowStart = now - config.windowMs;

    // Get current request timestamps
    const result = await kv.get<number[]>(key);
    let timestamps = result.value || [];

    // Remove timestamps outside the current window
    timestamps = timestamps.filter(ts => ts > windowStart);

    // Check if over limit
    if (timestamps.length >= maxRequests) {
      const oldestInWindow = Math.min(...timestamps);
      const resetAt = oldestInWindow + config.windowMs;

      kv.close();
      return {
        allowed: false,
        remaining: 0,
        resetAt,
        message: `Rate limit exceeded. Try again in ${Math.ceil((resetAt - now) / 1000)}s`
      };
    }

    // Add current request
    timestamps.push(now);
    await kv.set(key, timestamps, { expireIn: config.windowMs });

    const remaining = maxRequests - timestamps.length;
    kv.close();

    return {
      allowed: true,
      remaining,
      resetAt: now + config.windowMs
    };
  } catch (error) {
    console.error("Rate limit check failed:", error);
    // Fail open - allow request if rate limit check fails
    return {
      allowed: true,
      remaining: config.maxRequests,
      resetAt: Date.now() + config.windowMs
    };
  }
}

/**
 * Get rate limit headers for response
 */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    "x-ratelimit-limit": String(result.remaining + (result.allowed ? 1 : 0)),
    "x-ratelimit-remaining": String(result.remaining),
    "x-ratelimit-reset": String(Math.floor(result.resetAt / 1000)),
    ...(result.message ? { "x-ratelimit-message": result.message } : {})
  };
}

/**
 * Get identifier for rate limiting (IP or origin-based)
 */
function getIdentifier(req: Request): string {
  // Try to get real IP from headers (Cloudflare, etc.)
  const cfConnectingIp = req.headers.get("cf-connecting-ip");
  const xForwardedFor = req.headers.get("x-forwarded-for");
  const xRealIp = req.headers.get("x-real-ip");

  const ip = cfConnectingIp ||
             xForwardedFor?.split(",")[0].trim() ||
             xRealIp ||
             "unknown";

  const origin = req.headers.get("origin");

  // Use origin if available (more precise for browsers), otherwise IP
  return origin ? `origin:${origin}` : `ip:${ip}`;
}

/**
 * Check if origin is trusted (game domains, GitHub Pages)
 */
function isTrustedOrigin(origin: string | null): boolean {
  if (!origin) return false;

  const trusted = [
    "https://magiccircle.gg",
    "https://www.magiccircle.gg",
    "https://magicgarden.gg",
    "https://www.magicgarden.gg",
    "https://ryandt2305-cpu.github.io",
    "https://mg-tokyo.github.io"
  ];

  return trusted.some(t => origin.startsWith(t));
}
