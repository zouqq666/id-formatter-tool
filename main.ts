// main.ts - Deno Deploy server for ID formatter stats
// Uses Deno KV (built-in key-value store, no external database needed)
// Features: visit/user counting + IP geolocation (city-level, via ip-api.com)

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// Get today's date in Asia/Shanghai timezone (UTC+8)
function getTodayShanghai(): string {
  const now = new Date();
  const shanghaiTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return shanghaiTime.toISOString().slice(0, 10);
}

// Lazy KV init (deferred until first request to avoid module-load errors)
let kvPromise: Promise<Deno.Kv> | null = null;
function getKv(): Promise<Deno.Kv> {
  if (!kvPromise) {
    kvPromise = Deno.openKv();
  }
  return kvPromise;
}

// ---------- IP geolocation helpers ----------

// Extract client IP from request headers (Deno Deploy sets x-forwarded-for)
function getClientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    return xff.split(",")[0].trim();
  }
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  return null;
}

// Check if IP is private/local (skip geolocation for these)
function isPrivateIp(ip: string): boolean {
  if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

// Lookup IP location using ipapi.co (free, HTTPS, ~1000 req/day)
// Results are cached in KV (["ipCache", ip]) to avoid repeated API calls
// A 3-second timeout prevents the entire track request from hanging
async function lookupIpLocation(
  ip: string,
): Promise<{ province: string; city: string } | null> {
  if (isPrivateIp(ip)) return null;
  const kv = await getKv();

  // Check KV cache first
  const cached = await kv.get<{ province: string; city: string }>(["ipCache", ip]);
  if (cached.value) return cached.value;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(`https://ipapi.co/${ip}/json/`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    const data = await resp.json();
    if (data && !data.error && data.region) {
      const location = {
        province: data.region || "Unknown",
        city: data.city || data.region || "Unknown",
      };
      // Cache in KV for future requests
      await kv.set(["ipCache", ip], location);
      return location;
    }
  } catch (_e) {
    // Best-effort: timeout or fetch error → return null
  }
  return null;
}

// ---------- Read stats ----------
async function getStats() {
  const kv = await getKv();
  const [tv, tu, toV, toU] = await Promise.all([
    kv.get(["stats", "totalVisits"]),
    kv.get(["stats", "totalUsers"]),
    kv.get(["stats", "todayVisits"]),
    kv.get(["stats", "todayUsers"]),
  ]);
  return {
    totalVisits: Number(tv.value ?? 0),
    totalUsers: Number(tu.value ?? 0),
    todayVisits: Number(toV.value ?? 0),
    todayUsers: Number(toU.value ?? 0),
  };
}

// ---------- Track visit ----------
async function trackVisit(userId: string, req: Request) {
  const kv = await getKv();
  const today = getTodayShanghai();

  // Start IP location lookup in parallel (best-effort)
  const ip = getClientIp(req);
  const locationPromise = ip ? lookupIpLocation(ip) : Promise.resolve(null);

  const [lastDateRes, userExistsRes, todayUserExistsRes, totalsRes] =
    await Promise.all([
      kv.get<string>(["stats", "lastDate"]),
      kv.get(["allUsers", userId]),
      kv.get(["dailyUsers", today, userId]),
      Promise.all([
        kv.get(["stats", "totalVisits"]),
        kv.get(["stats", "totalUsers"]),
        kv.get(["stats", "todayVisits"]),
        kv.get(["stats", "todayUsers"]),
      ]),
    ]);

  const lastDate = lastDateRes.value;
  const userExists = userExistsRes.value !== null;
  const todayUserExists = todayUserExistsRes.value !== null;
  const isNewDay = lastDate !== today;

  const [tvRes, tuRes, tovRes, touRes] = totalsRes;
  const totalVisits = Number(tvRes.value ?? 0);
  const totalUsers = Number(tuRes.value ?? 0);
  const todayVisits = isNewDay ? 0 : Number(tovRes.value ?? 0);
  const todayUsers = isNewDay ? 0 : Number(touRes.value ?? 0);

  const newTotalVisits = totalVisits + 1;
  const newTodayVisits = todayVisits + 1;
  const newTotalUsers = userExists ? totalUsers : totalUsers + 1;
  const newTodayUsers = todayUserExists ? todayUsers : todayUsers + 1;

  const atomic = kv.atomic()
    .set(["stats", "totalVisits"], newTotalVisits)
    .set(["stats", "todayVisits"], newTodayVisits)
    .set(["stats", "totalUsers"], newTotalUsers)
    .set(["stats", "todayUsers"], newTodayUsers)
    .set(["stats", "lastDate"], today);

  if (!userExists) atomic.set(["allUsers", userId], true);
  if (!todayUserExists) atomic.set(["dailyUsers", today, userId], true);

  const result = await atomic.commit();
  if (!result.ok) {
    return trackVisit(userId, req);
  }

  // Update location counter (best-effort, after main commit succeeds)
  const location = await locationPromise.catch(() => null);
  if (location) {
    try {
      const locKey = ["locations", location.province, location.city] as const;
      let committed = false;
      for (let i = 0; i < 3 && !committed; i++) {
        const locRes = await kv.get<number>(locKey);
        const r = await kv.atomic()
          .set(locKey, Number(locRes.value ?? 0) + 1)
          .commit();
        committed = r.ok;
      }
    } catch (_e) {
      // Best-effort: if location update fails, ignore
    }
  }

  return {
    totalVisits: newTotalVisits,
    totalUsers: newTotalUsers,
    todayVisits: newTodayVisits,
    todayUsers: newTodayUsers,
  };
}

// ---------- Read locations ----------
async function getLocations() {
  const kv = await getKv();
  const locations: Array<{ province: string; city: string; count: number }> = [];
  for await (const entry of kv.list({ prefix: ["locations"] })) {
    const [, province, city] = entry.key as [string, string, string];
    locations.push({ province, city, count: Number(entry.value) });
  }
  locations.sort((a, b) => b.count - a.count);
  return locations;
}

// ---------- Reset all stats ----------
async function resetStats() {
  const kv = await getKv();
  const today = getTodayShanghai();

  // 1. Reset counters
  await kv.atomic()
    .set(["stats", "totalVisits"], 0)
    .set(["stats", "totalUsers"], 0)
    .set(["stats", "todayVisits"], 0)
    .set(["stats", "todayUsers"], 0)
    .set(["stats", "lastDate"], today)
    .commit();

  // 2. Delete all user dedup records
  for await (const entry of kv.list({ prefix: ["allUsers"] })) {
    await kv.delete(entry.key);
  }

  // 3. Delete all daily user dedup records
  for await (const entry of kv.list({ prefix: ["dailyUsers"] })) {
    await kv.delete(entry.key);
  }

  // 4. Delete all location records
  for await (const entry of kv.list({ prefix: ["locations"] })) {
    await kv.delete(entry.key);
  }

  // NOTE: ipCache is NOT cleared — it's a cache, not stats data

  return { totalVisits: 0, totalUsers: 0, todayVisits: 0, todayUsers: 0 };
}

// ---------- HTTP server ----------
Deno.serve(async (req: Request) => {
  try {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (path === "/" || path === "") {
      return jsonResponse({
        success: true,
        service: "id-formatter-stats",
        endpoints: [
          "/api/health",
          "/api/stats",
          "/api/track (POST)",
          "/api/locations",
          "/api/debug-ip",
          "/api/reset (POST)",
        ],
      });
    }

    if (path === "/api/health") {
      return jsonResponse({ success: true, message: "ok" });
    }

    if (path === "/api/stats" && req.method === "GET") {
      const data = await getStats();
      return jsonResponse({ success: true, data });
    }

    if (path === "/api/track" && req.method === "POST") {
      const body = await req.json();
      const userId = (body.userId as string) || crypto.randomUUID();
      const data = await trackVisit(userId, req);
      return jsonResponse({ success: true, data });
    }

    if (path === "/api/locations" && req.method === "GET") {
      const data = await getLocations();
      return jsonResponse({ success: true, data });
    }

    if (path === "/api/debug-ip" && req.method === "GET") {
      const ip = getClientIp(req);
      const location = ip ? await lookupIpLocation(ip) : null;
      return jsonResponse({
        success: true,
        data: {
          detectedIp: ip,
          isPrivate: ip ? isPrivateIp(ip) : null,
          location: location,
        },
      });
    }

    if (path === "/api/reset" && req.method === "POST") {
      const data = await resetStats();
      return jsonResponse({
        success: true,
        data,
        message: "All stats reset to 0",
      });
    }

    return jsonResponse({ success: false, error: "Not found" }, 404);
  } catch (e) {
    return jsonResponse({ success: false, error: String(e) }, 500);
  }
});
