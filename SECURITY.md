# Security Measures - Restock History Edge Function

## Overview

The `restock-history` edge function is designed to be safely exposed to the public while maintaining strong security controls.

## Security Layers

### 1. **CORS Whitelist**
- Only allows requests from approved origins
- Blocks unknown domains at the browser level
- Allows no-origin requests (for server-to-server, Tampermonkey)

**Allowed Origins:**
- Game domains: `magiccircle.gg`, `magicgarden.gg`, `starweaver.org`
- GitHub Pages: `mg-tokyo.github.io`
- Local testing: `localhost:8000`, `127.0.0.1:8000`

### 2. **Rate Limiting**
- IP/Origin-based rate limiting using Deno KV
- Sliding window algorithm for accurate rate tracking
- Different limits for trusted vs. untrusted origins

**Limits:**
- Default: **60 requests per minute** per IP/origin
- Trusted origins: **120 requests per minute**
- Headers: `X-RateLimit-*` headers in response

### 3. **Caching**
- ETag-based conditional requests (304 Not Modified)
- Cache-Control headers: `public, max-age=60, stale-while-revalidate=300`
- Reduces database load by serving cached responses

### 4. **Row Level Security (RLS)**
- Database tables protected by RLS policies
- Service role key only used in edge function
- No direct database access from frontend

### 5. **Request Validation**
- Method validation (only GET allowed)
- User-Agent and Origin logging for monitoring
- Suspicious pattern detection

### 6. **Security Headers**
```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
```

### 7. **Response Optimization**
- Minimal column selection (only needed fields)
- Compressed JSON responses
- No sensitive data in responses

## Public Anon Key - Why It's Safe

The Supabase anon key **is designed to be public** and exposed in frontend code. Here's why it's secure:

### Backend Protection
1. **RLS Policies**: Database rows are protected by Row Level Security
2. **Service Role**: Edge function uses service role, not anon key
3. **Function-level Auth**: Edge functions validate requests

### Limited Capabilities
The anon key can only:
- Call edge functions (which have their own validation)
- Access RLS-protected tables (with policies enforced)
- Read public data that's explicitly allowed

The anon key **cannot**:
- Bypass RLS policies
- Access admin functions
- Modify data without explicit RLS permission
- Read sensitive data

### Rate Limiting
Even with the anon key, abuse is prevented by:
- 60 requests/minute rate limit per IP
- Additional edge function-level controls
- Request logging and monitoring

## Monitoring

### Request Logging
Each request logs:
```json
{
  "timestamp": "2026-02-06T...",
  "origin": "https://...",
  "userAgent": "Mozilla/5.0...",
  "ip": "123.45.67.89",
  "remaining": 58
}
```

### Rate Limit Headers
Responses include rate limit info:
```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 58
X-RateLimit-Reset: 1707234567
```

### 429 Too Many Requests
```json
{
  "ok": false,
  "error": "Rate limit exceeded. Try again in 15s",
  "retryAfter": 15
}
```

## Deployment Checklist

Before deploying the restock tracker to GitHub Pages:

- [x] CORS whitelist includes GitHub Pages domain
- [x] Rate limiting enabled and tested
- [x] RLS policies verified on all tables
- [x] Caching headers configured
- [x] Security headers added
- [x] Request logging enabled
- [x] Error handling with proper status codes
- [x] Frontend cache strategy implemented

## Best Practices

### For Developers
1. **Never commit service role key** - only in environment variables
2. **Use anon key in frontend** - it's designed for this
3. **Respect rate limits** - implement client-side caching
4. **Handle 429 errors** - back off when rate limited

### For Frontend
1. **Cache responses** for 5 minutes minimum
2. **Use ETag** - include `If-None-Match` header
3. **Implement backoff** - exponential retry on errors
4. **Show rate limit status** - display remaining requests

## Incident Response

If abuse is detected:

1. **Check logs** in Supabase Functions dashboard
2. **Identify source** using IP/origin in logs
3. **Temporary block** by removing origin from CORS whitelist
4. **Adjust rate limits** if needed (reduce maxRequests)
5. **Add IP block** in Cloudflare or at Supabase level

## Future Improvements

Potential enhancements:
- [ ] Add request authentication beyond anon key (optional JWT)
- [ ] Implement user-specific rate limits (for logged-in users)
- [ ] Add request signature verification
- [ ] Implement circuit breaker for database protection
- [ ] Add Cloudflare rate limiting at edge
- [ ] Set up automated alerts for abuse patterns

## Questions?

For security concerns, contact the repository maintainer.
