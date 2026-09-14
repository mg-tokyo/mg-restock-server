import fs from "node:fs";
import path from "node:path";
import process from "node:process";
// Node 22+ has native fetch — node-fetch v3 hangs on some requests
// import fetch from "node-fetch";
import {
  DEFAULT_PLATFORM_API_BASE,
  didRestock,
  fetchPlatformShops,
  fetchPlatformWeather,
} from "./lib/platformApi.mjs";

// Live shop stock + weather come from the official Magic Garden platform API
// (replaces mg-api.ariedam.fr /live/* as of 2026-08).
// Reference: Feeder-Extension/docs/superpowers/specs/2026-08-16-mg-platform-api-reference.md
const PLATFORM_API_BASE = process.env.MG_PLATFORM_API_BASE || DEFAULT_PLATFORM_API_BASE;
const API_URL = `${PLATFORM_API_BASE}/shops`;
// mg-api is still used for static game data (/data/plants|eggs|decors) used to validate item ids.
const MG_API_BASE = process.env.MG_API_BASE || "https://mg-api.ariedam.fr";
const WEATHER_POLL_MS = Number(process.env.WEATHER_POLL_MS || 60000);

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const SNAPSHOT_FILE = path.join(DATA_DIR, "snapshot.json");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");
const EVENTS_FILE = path.join(DATA_DIR, "events.json");
const META_FILE = path.join(DATA_DIR, "meta.json");
const MGDATA_CACHE_FILE = path.join(DATA_DIR, "mgdata-cache.json");
const MGDATA_CACHE_MS = Number(process.env.MGDATA_CACHE_MS || 3600000);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 15000);
const LOAD_MGDATA_TIMEOUT_MS = Number(process.env.LOAD_MGDATA_TIMEOUT_MS || 30000);
const LOAD_HISTORY_FROM_DB = process.env.LOAD_HISTORY_FROM_DB !== "0";
const USE_DB_INGEST = process.env.USE_DB_INGEST !== "0";

// Populated dynamically from shop_type_registry on startup.
let SHOP_TYPES = [];
let SHOP_INTERVALS_SEC = {};
const MAX_EVENTS = 100000;
function historyFileForShop(shopType) {
  return path.join(DATA_DIR, `history-${shopType}.json`);
}

let cachedWeatherId = null;
let cachedWeatherAt = 0;

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
      Prefer: "resolution=merge-duplicates,return=representation",
      "x-client-info": "gemini-server-poll",
    }
  : null;
const WRITE_JSON = process.env.WRITE_JSON === "1" || !SUPABASE_HEADERS;

if (!SUPABASE_HEADERS) {
  console.warn(
    "[poll] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing. Running in local JSON mode only (no DB writes)."
  );
}

async function fetchShopTypeRegistry() {
  if (!SUPABASE_HEADERS || !SUPABASE_REST_ENDPOINT) {
    // Fallback to hardcoded defaults when running without DB
    SHOP_TYPES = ["seed", "egg", "decor", "tool", "dawn"];
    SHOP_INTERVALS_SEC = { seed: 300, egg: 900, decor: 3600, tool: 600, dawn: 300 };
    return;
  }
  const res = await fetch(
    `${SUPABASE_REST_ENDPOINT}/shop_type_registry?is_active=eq.true&select=shop_type,cycle_interval_ms`,
    { headers: SUPABASE_HEADERS }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch shop_type_registry: ${res.status} ${text}`);
  }
  const rows = await res.json();
  SHOP_TYPES = rows.map((r) => r.shop_type);
  SHOP_INTERVALS_SEC = {};
  for (const row of rows) {
    SHOP_INTERVALS_SEC[row.shop_type] = Math.round(row.cycle_interval_ms / 1000);
  }
  console.log(`[poll] Loaded ${rows.length} shop types from registry: ${SHOP_TYPES.join(", ")}`);
}

async function registerShopType(shopType, secondsUntilRestock) {
  if (!SUPABASE_HEADERS || !SUPABASE_REST_ENDPOINT) return;
  const estimatedMs = secondsUntilRestock
    ? Math.max(60000, Math.ceil((secondsUntilRestock * 1000) / 60000) * 60000)
    : 300000;
  const res = await fetch(`${SUPABASE_REST_ENDPOINT}/rpc/register_shop_type`, {
    method: "POST",
    headers: SUPABASE_HEADERS,
    body: JSON.stringify({
      p_shop_type: shopType,
      p_cycle_interval_ms: estimatedMs,
      p_discovered_from: "poll-script-auto",
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`[poll] Failed to register shop type "${shopType}": ${res.status} ${text}`);
    return;
  }
  SHOP_TYPES.push(shopType);
  SHOP_INTERVALS_SEC[shopType] = Math.round(estimatedMs / 1000);
  console.log(`[poll] Auto-registered new shop type "${shopType}" (cycle=${estimatedMs}ms)`);
}


function toNameSet(value) {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) return new Set(value.map((v) => String(v)));
  return new Set(Object.keys(value));
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function buildMgData(mg, nameIndex) {
  if (!mg || typeof mg !== "object") return null;
  const seed = mg.seed && typeof mg.seed === "object" ? mg.seed : {};
  const egg = mg.egg && typeof mg.egg === "object" ? mg.egg : {};
  const decor = mg.decor && typeof mg.decor === "object" ? mg.decor : {};
  const tool = mg.tool && typeof mg.tool === "object" ? mg.tool : null;
  const seedSet = toNameSet(seed);
  const eggSet = toNameSet(egg);
  const decorSet = toNameSet(decor);
  const toolSet = tool ? toNameSet(tool) : null;
  return {
    seed: seedSet,
    egg: eggSet,
    decor: decorSet,
    tool: toolSet,
    index: buildItemIndex({ seed: seedSet, egg: eggSet, decor: decorSet, tool: toolSet }, nameIndex),
    nameIndex: nameIndex ?? null,
  };
}

async function loadMgData() {
  const cached = readJson(MGDATA_CACHE_FILE, null);
  if (cached?.savedAt && cached?.data && Date.now() - cached.savedAt < MGDATA_CACHE_MS) {
    return buildMgData(cached.data, cached.nameIndex ?? null);
  }

  console.log("[poll] Fetching MGData endpoints...");
  const [plantsRes, eggsRes, decorsRes, toolsRes] = await Promise.all([
    fetchWithTimeout(`${MG_API_BASE}/data/plants`, { headers: { "User-Agent": "Gemini-Server" } }),
    fetchWithTimeout(`${MG_API_BASE}/data/eggs`, { headers: { "User-Agent": "Gemini-Server" } }),
    fetchWithTimeout(`${MG_API_BASE}/data/decors`, { headers: { "User-Agent": "Gemini-Server" } }),
    fetchWithTimeout(`${MG_API_BASE}/data/tools`, { headers: { "User-Agent": "Gemini-Server" } }).catch(() => null),
  ]);
  if (!plantsRes.ok || !eggsRes.ok || !decorsRes.ok) {
    throw new Error("MG API data fetch failed");
  }
  const [plants, eggs, decors] = await Promise.all([
    plantsRes.json(),
    eggsRes.json(),
    decorsRes.json(),
  ]);
  let tools = null;
  if (toolsRes && toolsRes.ok) {
    tools = await toolsRes.json();
  } else if (toolsRes && toolsRes.status !== 404) {
    console.warn(`[poll] /data/tools fetch failed with ${toolsRes.status}; skipping tool validation.`);
  }
  const seedNames = new Map();
  const eggNames = new Map();
  const decorNames = new Map();
  const toolNames = new Map();
  for (const [id, value] of Object.entries(plants ?? {})) {
    const seedName = value?.seed?.name;
    if (seedName) seedNames.set(normalizeKey(seedName), id);
  }
  for (const [id, value] of Object.entries(eggs ?? {})) {
    const eggName = value?.name;
    if (eggName) eggNames.set(normalizeKey(eggName), id);
  }
  for (const [id, value] of Object.entries(decors ?? {})) {
    const decorName = value?.name;
    if (decorName) decorNames.set(normalizeKey(decorName), id);
  }
  for (const [id, value] of Object.entries(tools ?? {})) {
    const toolName = value?.name;
    if (toolName) toolNames.set(normalizeKey(toolName), id);
  }
  const nameIndex = { seed: seedNames, egg: eggNames, decor: decorNames, tool: toolNames };
  const data = {
    seed: plants && typeof plants === "object" ? Object.keys(plants) : [],
    egg: eggs && typeof eggs === "object" ? Object.keys(eggs) : [],
    decor: decors && typeof decors === "object" ? Object.keys(decors) : [],
    ...(tools && typeof tools === "object" ? { tool: Object.keys(tools) } : {}),
  };
  writeJson(MGDATA_CACHE_FILE, { savedAt: Date.now(), data, nameIndex });
  return buildMgData(data, nameIndex);
}

async function fetchWeatherId() {
  const now = Date.now();
  if (cachedWeatherId && now - cachedWeatherAt < WEATHER_POLL_MS) {
    return cachedWeatherId;
  }
  try {
    // null payload => "Sunny"; unrecognised payload => null (logged so the shape can be pinned).
    const { raw, weatherId } = await fetchPlatformWeather(PLATFORM_API_BASE, {
      timeoutMs: FETCH_TIMEOUT_MS,
      userAgent: "Gemini-Server/poll",
    });
    if (weatherId === null) {
      console.warn("[poll] Unrecognised weather payload (pin the shape in scripts/lib/platformApi.mjs):", JSON.stringify(raw));
      return cachedWeatherId ?? null;
    }
    cachedWeatherId = weatherId;
    cachedWeatherAt = now;
    return weatherId;
  } catch {
    return cachedWeatherId ?? null;
  }
}
function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u2019']/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function normalizeItemName(value) {
  return String(value || "").trim();
}

const LEGACY_ALIASES = new Map([
  ["uncommoneggs", "UncommonEgg"],
  ["rareeggs", "RareEgg"],
  ["legendaryeggs", "LegendaryEgg"],
  ["mythicaleggs", "MythicalEgg"],
  ["snoweggs", "SnowEgg"],
  ["wintereggs", "WinterEgg"],
  ["commoneggs", "CommonEgg"],
  ["moonbinder", "MoonCelestial"],
  ["moonbinderpod", "MoonCelestial"],
  ["dawnbinder", "DawnCelestial"],
  ["dawnbinderpod", "DawnCelestial"],
  ["burrostail", "BurrosTail"],
  ["stringlights", "StringLights"],
  ["coloredstringlights", "ColoredStringLights"],
  ["haybale", "HayBale"],
  ["woodowl", "WoodOwl"],
  ["woodbirdhouse", "WoodBirdhouse"],
  ["stonebirdbath", "StoneBirdbath"],
  ["stonegnome", "StoneGnome"],
  ["marbleblobling", "MarbleBlobling"],
  ["pet hutch", "PetHutch"],
  ["decor shed", "DecorShed"],
  ["seed silo", "SeedSilo"],
  ["moonbinder", "Moonbinder"],
  ["dawnbinder", "Dawnbinder"],
]);

// Weather alias table + normalizeWeather() now live in scripts/lib/platformApi.mjs.

function buildItemIndex(mgSets, nameIndex) {
  const index = { seed: new Map(), egg: new Map(), decor: new Map(), tool: new Map() };
  for (const shopType of ["seed", "egg", "decor", "tool"]) {
    const set = mgSets[shopType];
    if (!set) continue;
    for (const id of set) {
      const key = normalizeKey(id);
      if (!index[shopType].has(key)) index[shopType].set(key, id);
    }
    const names = nameIndex?.[shopType];
    if (names) {
      const entries = names instanceof Map ? names.entries() : Object.entries(names);
      for (const [key, id] of entries) {
        if (!index[shopType].has(key)) index[shopType].set(key, id);
      }
    }
  }
  return index;
}

function resolveItemId(shopType, rawName, mgSets) {
  if (!mgSets) return rawName;
  const set = shopType === "seed" ? mgSets.seed : shopType === "egg" ? mgSets.egg : shopType === "tool" ? (mgSets.tool ?? null) : mgSets.decor;
  if (set && set.has(rawName)) return rawName;
  const idx = mgSets.index?.[shopType];
  if (!idx) return null;
  const raw = normalizeItemName(rawName);
  const key = normalizeKey(raw);
  if (!key) return null;
  if (LEGACY_ALIASES.has(key)) return LEGACY_ALIASES.get(key);
  if (LEGACY_ALIASES.has(raw.toLowerCase())) return LEGACY_ALIASES.get(raw.toLowerCase());
  if (idx.has(key)) return idx.get(key);
  if (key.endsWith("seed")) {
    const trimmed = key.replace(/seed(s)?$/, "");
    if (idx.has(trimmed)) return idx.get(trimmed);
  }
  if (key.endsWith("egg")) {
    const trimmed = key.replace(/egg(s)?$/, "");
    if (idx.has(trimmed)) return idx.get(trimmed);
  }
  // Try simple singularization for legacy plural names (e.g., Eggs -> Egg)
  if (key.endsWith("s")) {
    const singular = key.slice(0, -1);
    if (idx.has(singular)) return idx.get(singular);
  }
  if (key.endsWith("es")) {
    const singular = key.slice(0, -2);
    if (idx.has(singular)) return idx.get(singular);
  }
  return null;
}

function validateItems(shopType, items, mgSets) {
  if (!mgSets) return items;
  const set = shopType === "seed" ? mgSets.seed : shopType === "egg" ? mgSets.egg : shopType === "tool" ? (mgSets.tool ?? null) : mgSets.decor;
  if (!set || set.size === 0) return items;
  const out = [];
  for (const item of items) {
    const resolved = resolveItemId(shopType, item.name, mgSets);
    if (!resolved) continue;
    out.push({ ...item, name: resolved });
  }
  return out;
}
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

async function upsertRestockHistory(items) {
  if (!SUPABASE_HEADERS || !SUPABASE_REST_ENDPOINT) return;
  const body = Object.values(items).map((row) => ({
    item_id: row.itemId,
    shop_type: row.shopType,
    total_occurrences: row.totalOccurrences,
    first_seen: row.firstSeen,
    last_seen: row.lastSeen,
    average_interval_ms: row.averageIntervalMs,
    estimated_next_timestamp: row.estimatedNextTimestamp,
    average_quantity: row.averageQuantity,
    last_quantity: row.lastQuantity,
    rate_per_day: row.ratePerDay,
    total_quantity: row.totalQuantity ?? null,
  }));
  if (body.length === 0) return;
  const res = await fetch(
    `${SUPABASE_REST_ENDPOINT}/restock_history?on_conflict=item_id,shop_type`,
    {
      method: "POST",
      headers: SUPABASE_HEADERS,
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert restock_history failed: ${res.status} ${text}`);
  }
}

async function insertRestockEvents(events) {
  if (!SUPABASE_HEADERS || !SUPABASE_REST_ENDPOINT) return;
  if (!events || events.length === 0) return;
  const payload = events.map((ev) => ({
    timestamp: ev.timestamp,
    shop_type: ev.shopType,
    weather_id: ev.weatherId ?? null,
    items: ev.items.map((item) => ({ itemId: item.itemId, stock: item.stock ?? item.quantity ?? null })),
    source: "poller",
    fingerprint: makeFingerprint(ev),
  }));
  const res = await fetch(`${SUPABASE_REST_ENDPOINT}/restock_events?on_conflict=fingerprint`, {
    method: "POST",
    headers: SUPABASE_HEADERS,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 409) {
      return;
    }
    throw new Error(`Supabase insert restock_events failed: ${res.status} ${text}`);
  }
}

function makeFingerprint(ev) {
  const items = Array.isArray(ev.items) ? ev.items : [];
  const parts = items
    .map((item) => `${item.itemId}:${item.stock ?? item.quantity ?? ""}`)
    .sort()
    .join("|");
  return `${ev.shopType}:${ev.timestamp}:${parts}`;
}

async function ingestRestockHistory(events) {
  if (!SUPABASE_HEADERS || !SUPABASE_REST_ENDPOINT) return;
  for (const ev of events) {
    const res = await fetch(`${SUPABASE_REST_ENDPOINT}/rpc/ingest_restock_history`, {
      method: "POST",
      headers: SUPABASE_HEADERS,
      body: JSON.stringify({
        p_shop_type: ev.shopType,
        p_ts: ev.timestamp,
        p_items: ev.items,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Supabase ingest_restock_history failed: ${res.status} ${text}`);
    }
  }
}

async function loadRestockHistoryFromDb() {
  if (!SUPABASE_HEADERS || !SUPABASE_REST_ENDPOINT) return null;
  const history = {};
  const limit = 1000;
  let offset = 0;
  while (true) {
    const res = await fetch(
      `${SUPABASE_REST_ENDPOINT}/restock_history?select=*&limit=${limit}&offset=${offset}`,
      { headers: SUPABASE_HEADERS }
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Supabase read restock_history failed: ${res.status} ${text}`);
    }
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      const key = `${row.shop_type}:${row.item_id}`;
      history[key] = {
        itemId: row.item_id,
        shopType: row.shop_type,
        totalOccurrences: row.total_occurrences ?? 0,
        totalQuantity: row.total_quantity ?? null,
        firstSeen: row.first_seen ?? null,
        lastSeen: row.last_seen ?? null,
        averageIntervalMs: row.average_interval_ms ?? null,
        estimatedNextTimestamp: row.estimated_next_timestamp ?? null,
        averageQuantity: row.average_quantity ?? null,
        lastQuantity: row.last_quantity ?? null,
        ratePerDay: row.rate_per_day ?? null,
      };
    }
    if (rows.length < limit) break;
    offset += limit;
  }
  return history;
}

function nowMs() {
  return Date.now();
}

function keyOf(shopType, itemId) {
  return `${shopType}:${itemId}`;
}

/**
 * Convert normalised platform shops (from fetchPlatformShops) into the on-disk
 * snapshot shape. Items keep the internal `name` key (= platform `itemId`) because
 * validateItems()/resolveItemId() operate on `item.name`.
 */
function normalizeSnapshot(platformShops) {
  const out = {};
  // Iterate all shop keys present in the snapshot (covers registry + newly discovered)
  const shopKeys = new Set([...SHOP_TYPES, ...Object.keys(platformShops ?? {})]);
  for (const shopType of shopKeys) {
    const shop = platformShops?.[shopType] ?? null;
    const items = Array.isArray(shop?.items) ? shop.items : [];
    out[shopType] = {
      open: shop?.open === true,
      nextRestockAt: typeof shop?.nextRestockAt === "number" ? shop.nextRestockAt : null,
      secondsUntilRestock: typeof shop?.secondsUntilRestock === "number" ? shop.secondsUntilRestock : 0,
      lastRestockAt: null, // carried forward from the previous snapshot in main()
      items: items
        .filter((item) => item?.itemId && item.stock > 0)
        .map((item) => ({
          name: String(item.itemId),
          stock: typeof item.stock === "number" ? item.stock : 0,
        })),
    };
  }
  return out;
}

function indexItems(items) {
  const map = new Map();
  for (const item of items) {
    if (!item?.name) continue;
    map.set(item.name, item);
  }
  return map;
}

function detectRestock(prev, next, shopType) {
  if (!prev) return true;
  // A weather-gated / event shop that just opened is always a fresh stock roll
  // (even if it reports no nextRestockAt while open — behaviour not yet observed).
  if (prev.open === false && next.open) return true;
  // Primary signal (official API): the shop's nextRestockAt moved => a restock happened.
  // Falls through to the legacy secondsUntilRestock heuristics only when either side
  // lacks nextRestockAt (e.g. a snapshot.json written by the pre-2026-08 mg-api poller).
  const byTimestamp = didRestock(prev.nextRestockAt ?? null, next.nextRestockAt ?? null);
  if (byTimestamp !== null) return byTimestamp;
  const prevSec = typeof prev.secondsUntilRestock === "number" ? prev.secondsUntilRestock : 0;
  const nextSec = typeof next.secondsUntilRestock === "number" ? next.secondsUntilRestock : 0;
  if (prevSec > 0 && nextSec > prevSec + 30) return true;
  if (prevSec > 0 && nextSec === 0) return true;
  if (prevSec <= 5 && nextSec > prevSec) return true;

  const intervalSec = SHOP_INTERVALS_SEC[shopType] ?? null;
  if (intervalSec && prev.lastRestockAt && typeof prev.lastRestockAt === "number") {
    const since = Date.now() - prev.lastRestockAt;
    if (since >= intervalSec * 1000 && nextSec > prevSec) return true;
  }
  return false;
}


function pushEvent(events, event) {
  events.unshift(event);
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
}

function updateHistory(history, event) {
  for (const item of event.items) {
    const k = keyOf(event.shopType, item.itemId);
    const existing = history[k];
    const qty = typeof item.stock === "number" ? item.stock : null;
    if (!existing) {
      history[k] = {
        itemId: item.itemId,
        shopType: event.shopType,
        totalOccurrences: 1,
        totalQuantity: qty ?? null,
        firstSeen: event.timestamp,
        lastSeen: event.timestamp,
        averageIntervalMs: null,
        estimatedNextTimestamp: null,
        averageQuantity: qty,
        lastQuantity: qty,
        ratePerDay: null,
      };
      continue;
    }
    existing.totalOccurrences += 1;
    existing.lastSeen = event.timestamp;
    if (!existing.firstSeen || event.timestamp < existing.firstSeen) {
      existing.firstSeen = event.timestamp;
    }
    if (typeof qty === "number") {
      if (typeof existing.averageQuantity === "number") {
        existing.averageQuantity = Math.round((existing.averageQuantity + qty) / 2);
      } else {
        existing.averageQuantity = qty;
      }
      existing.lastQuantity = qty;
      existing.totalQuantity = (existing.totalQuantity ?? 0) + qty;
    }
  }
}

function splitHistoryByShop(history) {
  const result = {};
  for (const shopType of SHOP_TYPES) {
    result[shopType] = {};
  }
  for (const [key, value] of Object.entries(history)) {
    if (!result[value.shopType]) result[value.shopType] = {};
    result[value.shopType][key] = value;
  }
  return result;
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // Load shop types from registry before anything else
  await fetchShopTypeRegistry();

  const prevSnapshot = readJson(SNAPSHOT_FILE, null);
  let history = readJson(HISTORY_FILE, {});
  const events = readJson(EVENTS_FILE, []);
  const meta = readJson(META_FILE, {});

  if (SUPABASE_HEADERS && LOAD_HISTORY_FROM_DB) {
    try {
      const dbHistory = await loadRestockHistoryFromDb();
      if (dbHistory) history = dbHistory;
    } catch (err) {
      console.warn("Failed to load restock_history from DB, falling back to local history.", err);
    }
  }

  console.log("Fetching live shops (official platform API)...");
  // fetchPlatformShops refetches (bounded) while any open shop reports nextRestockAt <= now,
  // i.e. when we polled a few hundred ms before the server rolled the restock.
  const { shops: live, staleRetries } = await fetchPlatformShops(PLATFORM_API_BASE, {
    timeoutMs: FETCH_TIMEOUT_MS,
    userAgent: "Gemini-Server/poll",
  });
  if (staleRetries > 0) console.log(`[poll] Refetched ${staleRetries}x waiting for restock boundary.`);

  // Auto-register any new OPEN shop types discovered in the API response
  const knownShopTypes = new Set(SHOP_TYPES);
  for (const shopType of Object.keys(live)) {
    if (!knownShopTypes.has(shopType) && live[shopType]?.open && live[shopType].items.length > 0) {
      await registerShopType(shopType, live[shopType].secondsUntilRestock);
    }
  }

  console.log("Loading MGData...");
  const mgSets = await Promise.race([
    loadMgData(),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`MGData load timed out after ${LOAD_MGDATA_TIMEOUT_MS}ms`)), LOAD_MGDATA_TIMEOUT_MS);
    }),
  ]).catch((err) => {
    console.warn(`[poll] MGData unavailable; proceeding without strict item validation. ${err?.message ?? err}`);
    return null;
  });
  const nextSnapshot = normalizeSnapshot(live);
  // null when the weather endpoint is unreachable/unrecognised (restock_events.weather_id is nullable).
  const liveWeatherId = await fetchWeatherId();
  if (!mgSets || (!mgSets.seed && !mgSets.egg && !mgSets.decor && !mgSets.tool)) {
    console.warn("MGDATA validation disabled or empty; skipping item validation.");
  }

  const timestamp = nowMs();
  const newEvents = [];

  for (const shopType of Object.keys(nextSnapshot)) {
    const prevShop = prevSnapshot?.[shopType] ?? null;
    const nextShop = nextSnapshot[shopType];
    // Closed (weather-gated / event) shops and empty inventories never produce events.
    const restockByTimer = nextShop.open && nextShop.items.length > 0
      ? detectRestock(prevShop, nextShop, shopType)
      : false;

    if (restockByTimer) {
      const validatedItems = validateItems(shopType, nextShop.items, mgSets);
      if (mgSets && validatedItems.length === 0 && nextShop.items.length > 0) {
        continue;
      }
      const event = {
        shopType,
        timestamp,
        weatherId: liveWeatherId,
        items: validatedItems.map((item) => ({
          itemId: item.name,
          stock: item.stock,
        })),
        reason: "timer",
      };
      pushEvent(events, event);
      newEvents.push(event);
      updateHistory(history, event);
      nextSnapshot[shopType].lastRestockAt = timestamp;
    } else if (prevShop?.lastRestockAt) {
      nextSnapshot[shopType].lastRestockAt = prevShop.lastRestockAt;
    }
    if (!nextSnapshot[shopType].lastRestockAt) {
      nextSnapshot[shopType].lastRestockAt = timestamp;
    }
  }

  const needsLocalStats = WRITE_JSON || !SUPABASE_HEADERS;
  if (needsLocalStats) {
    // Compute server-side stats for predictions
    for (const item of Object.values(history)) {
      const interval = item.totalOccurrences > 1 && item.firstSeen && item.lastSeen
        ? Math.max(1, Math.round((item.lastSeen - item.firstSeen) / (item.totalOccurrences - 1)))
        : null;
      item.averageIntervalMs = interval;
      if (interval && item.lastSeen) {
        let next = item.lastSeen + interval;
        while (next <= timestamp) next += interval;
        item.estimatedNextTimestamp = next;
      } else {
        item.estimatedNextTimestamp = null;
      }
      if (item.firstSeen && item.lastSeen && item.lastSeen > item.firstSeen) {
        const days = (item.lastSeen - item.firstSeen) / 86400000;
        item.ratePerDay = days > 0 ? Number((item.totalOccurrences / days).toFixed(2)) : null;
      } else {
        item.ratePerDay = null;
      }
    }
  }

  console.log(`Detected ${newEvents.length} new restock events. Weather: ${liveWeatherId ?? "unknown"}`);

  if (newEvents.length > 0) {
    await insertRestockEvents(newEvents);
    if (USE_DB_INGEST) {
      await ingestRestockHistory(newEvents);
    } else if (needsLocalStats) {
      await upsertRestockHistory(history);
    }
  }

  if (WRITE_JSON) {
    writeJson(SNAPSHOT_FILE, nextSnapshot);
    writeJson(HISTORY_FILE, history);
    const split = splitHistoryByShop(history);
    for (const shopType of Object.keys(split)) {
      writeJson(historyFileForShop(shopType), split[shopType]);
    }
    writeJson(EVENTS_FILE, events);
    writeJson(META_FILE, {
      lastUpdated: timestamp,
      source: API_URL,
      shopTypes: SHOP_TYPES,
      eventCount: events.length,
      historyCount: Object.keys(history).length,
    });
  }

}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
