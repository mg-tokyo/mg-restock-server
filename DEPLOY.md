# Deployment Guide - Security Hardened Restock Tracker

## 🚀 Quick Deploy

### 1. Deploy Backend (Edge Function)

```bash
cd C:\Users\ryand\Feeder-Extension\Gemini-folder\Gemini-server

# Deploy the edge function with new security features
# IMPORTANT: Use --no-verify-jwt to allow anon key requests
supabase functions deploy restock-history --no-verify-jwt

# Verify deployment
curl -X GET "https://xjuvryjgrjchbhjixwzh.supabase.co/functions/v1/restock-history" \
  -H "apikey: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhqdXZyeWpncmpjaGJoaml4d3poIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAxMDYyODMsImV4cCI6MjA4NTY4MjI4M30.MqQCBG-UMR4HYJU44Tz2orHUj9gMgJTMJtxpb_MHeps" \
  -H "Origin: https://mg-tokyo.github.io"
```

**Why `--no-verify-jwt`?**
- Allows anon key authentication from frontend
- Without it, you get 401 Unauthorized errors
- This is safe because we have 4 layers of protection (CORS, rate limiting, RLS, request validation)

### 2. Deploy Frontend (GitHub Pages)

```bash
cd C:\Users\ryand\Feeder-Extension

# Add and commit the tracker
git add helpers/magic_garden_research/viz/restock-tracker/
git commit -m "Deploy security-hardened restock tracker"
git push origin main
```

### 3. Enable GitHub Pages

1. Go to: `https://github.com/YOUR_USERNAME/Feeder-Extension/settings/pages`
2. Source: **Deploy from a branch**
3. Branch: **main** → Folder: **/** (root)
4. Click **Save**
5. Wait 1-2 minutes for deployment

### 4. Access Your Tracker

URL: `https://mg-tokyo.github.io/Feeder-Extension/helpers/magic_garden_research/viz/restock-tracker/`

## 🧪 Testing

### Test Rate Limiting

```bash
# This should succeed (first request)
curl -H "Origin: https://mg-tokyo.github.io" \
     -H "apikey: YOUR_ANON_KEY" \
     https://xjuvryjgrjchbhjixwzh.supabase.co/functions/v1/restock-history

# Rapid fire 70 requests (should get 429 after 60)
for i in {1..70}; do
  curl -s -H "Origin: https://mg-tokyo.github.io" \
       -H "apikey: YOUR_ANON_KEY" \
       https://xjuvryjgrjchbhjixwzh.supabase.co/functions/v1/restock-history \
       -w "\n%{http_code}\n" | tail -1
done
```

Expected: First 60 return `200`, remaining return `429`

### Test CORS

```bash
# Should work (allowed origin)
curl -H "Origin: https://mg-tokyo.github.io" \
     -H "apikey: YOUR_ANON_KEY" \
     https://xjuvryjgrjchbhjixwzh.supabase.co/functions/v1/restock-history \
     -I | grep "access-control-allow-origin"

# Should fail (unknown origin)
curl -H "Origin: https://evil-site.com" \
     -H "apikey: YOUR_ANON_KEY" \
     https://xjuvryjgrjchbhjixwzh.supabase.co/functions/v1/restock-history \
     -I | grep "access-control-allow-origin"
```

### Test Caching

```bash
# First request (should set ETag)
ETAG=$(curl -s -I \
  -H "Origin: https://mg-tokyo.github.io" \
  -H "apikey: YOUR_ANON_KEY" \
  https://xjuvryjgrjchbhjixwzh.supabase.co/functions/v1/restock-history \
  | grep -i etag | cut -d' ' -f2 | tr -d '\r')

echo "ETag: $ETAG"

# Second request with If-None-Match (should return 304)
curl -s -I \
  -H "Origin: https://mg-tokyo.github.io" \
  -H "apikey: YOUR_ANON_KEY" \
  -H "If-None-Match: $ETAG" \
  https://xjuvryjgrjchbhjixwzh.supabase.co/functions/v1/restock-history
```

Expected: Second request returns `304 Not Modified`

### Test Frontend Locally

```bash
cd C:\Users\ryand\Feeder-Extension\helpers\magic_garden_research\viz\restock-tracker

# Start local server
python -m http.server 8000

# Open browser to http://localhost:8000
# Check browser console for:
# - Successful data load
# - No CORS errors
# - Rate limit headers in Network tab
```

## 📊 Monitor

### View Logs

```bash
# Supabase CLI
supabase functions logs restock-history

# Or in Supabase Dashboard:
# https://supabase.com/dashboard/project/xjuvryjgrjchbhjixwzh/functions/restock-history/logs
```

### Check Rate Limit Status

Response headers will show:
```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 58
X-RateLimit-Reset: 1707234567
```

## 🔧 Troubleshooting

### Issue: CORS Error from GitHub Pages

**Problem:** `Access to fetch...has been blocked by CORS policy`

**Solution:**
1. Verify origin is in CORS whitelist: `cors.ts`
2. Check deployed edge function includes CORS updates
3. Redeploy edge function: `supabase functions deploy restock-history`

### Issue: Rate Limited Immediately

**Problem:** Getting 429 on first request

**Solution:**
1. Check Deno KV is enabled in Supabase project
2. Wait 60 seconds for rate limit to reset
3. Check if multiple users sharing same IP

### Issue: Stale Data

**Problem:** Data not updating

**Solution:**
1. Check "Last updated" timestamp in UI
2. Click "🔄 Refresh" button (respects 30s minimum)
3. Clear browser cache and localStorage
4. Check edge function logs for errors

### Issue: 404 on Decor Items

**Problem:** `/data/decor` returns 404

**Solution:** This is expected and handled gracefully. Decor endpoint doesn't exist yet.

## 📋 Post-Deployment Checklist

- [ ] Edge function deployed and accessible
- [ ] Rate limiting working (test with 70 requests)
- [ ] CORS configured (test from GitHub Pages)
- [ ] Frontend deployed to GitHub Pages
- [ ] GitHub Pages URL accessible
- [ ] No CORS errors in browser console
- [ ] Data loads successfully
- [ ] Cache working (check Network tab)
- [ ] Rate limit headers visible
- [ ] Manual refresh button works
- [ ] Theme toggle works
- [ ] Search and filters work
- [ ] Item tracking works
- [ ] Predictions card updates

## 🎯 Success Criteria

✅ **Security:**
- Rate limiting active (60/min)
- CORS whitelist enforced
- No 500 errors in logs
- Request logging working

✅ **Performance:**
- Initial load < 2 seconds
- Cache reduces API calls
- ETag 304 responses working
- No unnecessary requests

✅ **User Experience:**
- Data displays correctly
- Search and filters work
- Item tracking persists
- Mobile responsive
- Theme toggle works

## 🔐 Security Notes

**Remember:**
- ✅ Anon key in frontend is **by design** (safe)
- ✅ Service role key stays in **environment only**
- ✅ RLS protects database access
- ✅ Rate limiting prevents abuse
- ✅ CORS blocks unknown origins

## 🆘 Support

If you encounter issues:
1. Check Supabase Functions logs
2. Check browser console for errors
3. Verify GitHub Pages deployment status
4. Test with curl to isolate frontend vs backend issues

---

**Deployment Complete! 🎉**

Your restock tracker is now live with:
- 🔒 4-layer security protection
- ⚡ Aggressive caching
- 📊 Rate limiting
- 🛡️ CORS protection
- 📝 Request monitoring
