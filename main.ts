// main.ts - Deno Deploy server for ID formatter stats
// Uses TiDB Cloud Serverless (MySQL compatible) via @tidbcloud/serverless HTTP driver
// Features: visit/user counting + IP geolocation (city-level, via ipapi.co)
// Tables auto-created on first request (ensureTables)

import { connect } from "npm:@tidbcloud/serverless";

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

// Get today's date as a number (e.g., 20260809) — for storing in BIGINT column
function getTodayShanghaiNum(): number {
  return parseInt(getTodayShanghai().replace(/-/g, ""), 10);
}

// ---------- Database connection (lazy init) ----------

let conn: ReturnType<typeof connect> | null = null;

function getConnection() {
  if (!conn) {
    const url = Deno.env.get("DATABASE_URL");
    if (!url) throw new Error("DATABASE_URL is not set");
    // fullResult: true so execute() returns { rows, rowsAffected, lastInsertId }
    conn = connect({ url, fullResult: true });
  }
  return conn;
}

// Auto-create tables on first request
let tablesReady = false;
async function ensureTables() {
  if (tablesReady) return;
  const c = getConnection();

  await c.execute(`
    CREATE TABLE IF NOT EXISTS stats (
      stat_key VARCHAR(50) PRIMARY KEY,
      stat_value BIGINT NOT NULL DEFAULT 0
    )
  `);
  await c.execute(`
    CREATE TABLE IF NOT EXISTS all_users (
      user_id VARCHAR(100) PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await c.execute(`
    CREATE TABLE IF NOT EXISTS daily_users (
      stat_date VARCHAR(10) NOT NULL,
      user_id VARCHAR(100) NOT NULL,
      PRIMARY KEY (stat_date, user_id)
    )
  `);
  await c.execute(`
    CREATE TABLE IF NOT EXISTS locations (
      province VARCHAR(100) NOT NULL,
      city VARCHAR(100) NOT NULL,
      visit_count INT NOT NULL DEFAULT 0,
      PRIMARY KEY (province, city)
    )
  `);
  await c.execute(`
    CREATE TABLE IF NOT EXISTS ip_cache (
      ip VARCHAR(50) PRIMARY KEY,
      province VARCHAR(100),
      city VARCHAR(100)
    )
  `);

  tablesReady = true;
}

// ---------- IP geolocation helpers ----------

function getClientIp(req: Request, info?: { remoteAddr?: { hostname?: string } }): string | null {
  // Try standard headers first
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return cleanIp(xff.split(",")[0].trim());
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cleanIp(cf.trim());
  const xRealIp = req.headers.get("x-real-ip");
  if (xRealIp) return cleanIp(xRealIp.trim());
  const xClientIp = req.headers.get("x-client-ip");
  if (xClientIp) return cleanIp(xClientIp.trim());
  const flyClient = req.headers.get("fly-client-ip");
  if (flyClient) return cleanIp(flyClient.trim());
  // Fallback: Deno.serve info.remoteAddr
  if (info?.remoteAddr?.hostname) {
    const host = cleanIp(info.remoteAddr.hostname);
    if (!isPrivateIp(host)) return host;
  }
  return null;
}

// Strip IPv4-mapped IPv6 prefix (::ffff:) so IP geolocation services work
function cleanIp(ip: string): string {
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  return ip;
}

function isPrivateIp(ip: string): boolean {
  if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

// Lookup IP location: try ip-api.com (Chinese) first, fall back to ipapi.co (English)
// Results cached in ip_cache table to avoid repeated API calls
async function lookupIpLocation(
  ip: string,
): Promise<{ province: string; city: string } | null> {
  if (isPrivateIp(ip)) return null;
  const c = getConnection();

  // Check DB cache first
  const cached = await c.execute(
    "SELECT province, city FROM ip_cache WHERE ip = ?",
    [ip],
  );
  if (cached.rows && cached.rows.length > 0) {
    return {
      province: cached.rows[0].province,
      city: cached.rows[0].city,
    };
  }

  // Try ip-api.com (free, Chinese language, HTTP)
  try {
    const controller1 = new AbortController();
    const timer1 = setTimeout(() => controller1.abort(), 3000);
    const resp1 = await fetch(
      `http://ip-api.com/json/${ip}?lang=zh-CN&fields=status,regionName,city`,
      { signal: controller1.signal },
    );
    clearTimeout(timer1);
    const data1 = await resp1.json();
    if (data1.status === "success" && data1.regionName) {
      const location = {
        province: data1.regionName,
        city: data1.city || data1.regionName,
      };
      await c.execute(
        "INSERT IGNORE INTO ip_cache (ip, province, city) VALUES (?, ?, ?)",
        [ip, location.province, location.city],
      );
      return location;
    }
  } catch (_e) {
    // Fall through to ipapi.co
  }

  // Fall back to ipapi.co (HTTPS, English, ~1000 req/day)
  try {
    const controller2 = new AbortController();
    const timer2 = setTimeout(() => controller2.abort(), 3000);
    const resp2 = await fetch(`https://ipapi.co/${ip}/json/`, {
      signal: controller2.signal,
    });
    clearTimeout(timer2);
    const data2 = await resp2.json();
    if (data2 && !data2.error && data2.region) {
      const location = {
        province: data2.region || "Unknown",
        city: data2.city || data2.region || "Unknown",
      };
      await c.execute(
        "INSERT IGNORE INTO ip_cache (ip, province, city) VALUES (?, ?, ?)",
        [ip, location.province, location.city],
      );
      return location;
    }
  } catch (_e) {
    // Best-effort: both lookups failed
  }
  return null;
}

// ---------- Read stats ----------
async function getStats() {
  const c = getConnection();
  const result = await c.execute(
    "SELECT stat_key, stat_value FROM stats WHERE stat_key IN ('totalVisits', 'totalUsers', 'todayVisits', 'todayUsers')",
  );

  const stats: Record<string, number> = {};
  if (result.rows) {
    for (const row of result.rows) {
      stats[row.stat_key] = Number(row.stat_value);
    }
  }

  return {
    totalVisits: stats.totalVisits ?? 0,
    totalUsers: stats.totalUsers ?? 0,
    todayVisits: stats.todayVisits ?? 0,
    todayUsers: stats.todayUsers ?? 0,
  };
}

// ---------- Track visit ----------
async function trackVisit(userId: string, req: Request, info?: { remoteAddr?: { hostname?: string } }) {
  const c = getConnection();
  const today = getTodayShanghai();
  const todayNum = getTodayShanghaiNum();

  // IP extracted here for location lookup below
  const ip = getClientIp(req, info);

  // 1. Check and handle day reset (lastDate stored as number, e.g. 20260809)
  const dateResult = await c.execute(
    "SELECT stat_value FROM stats WHERE stat_key = 'lastDate'",
  );
  const lastDate = dateResult.rows && dateResult.rows.length > 0
    ? Number(dateResult.rows[0].stat_value)
    : null;

  if (lastDate !== todayNum) {
    // New day: reset today's counters
    await c.execute(
      "INSERT INTO stats (stat_key, stat_value) VALUES ('todayVisits', 0) ON DUPLICATE KEY UPDATE stat_value = 0",
    );
    await c.execute(
      "INSERT INTO stats (stat_key, stat_value) VALUES ('todayUsers', 0) ON DUPLICATE KEY UPDATE stat_value = 0",
    );
    await c.execute(
      "INSERT INTO stats (stat_key, stat_value) VALUES ('lastDate', ?) ON DUPLICATE KEY UPDATE stat_value = ?",
      [todayNum, todayNum],
    );
    // Clean old daily users
    await c.execute("DELETE FROM daily_users WHERE stat_date < ?", [today]);
  }

  // 2. Increment visit counters
  await c.execute(
    "INSERT INTO stats (stat_key, stat_value) VALUES ('totalVisits', 1) ON DUPLICATE KEY UPDATE stat_value = stat_value + 1",
  );
  await c.execute(
    "INSERT INTO stats (stat_key, stat_value) VALUES ('todayVisits', 1) ON DUPLICATE KEY UPDATE stat_value = stat_value + 1",
  );

  // 3. Add user (if new, increment totalUsers)
  const userResult = await c.execute(
    "INSERT IGNORE INTO all_users (user_id) VALUES (?)",
    [userId],
  );
  if (userResult.rowsAffected && userResult.rowsAffected > 0) {
    await c.execute(
      "INSERT INTO stats (stat_key, stat_value) VALUES ('totalUsers', 1) ON DUPLICATE KEY UPDATE stat_value = stat_value + 1",
    );
  }

  // 4. Add daily user (if new, increment todayUsers)
  const dailyResult = await c.execute(
    "INSERT IGNORE INTO daily_users (stat_date, user_id) VALUES (?, ?)",
    [today, userId],
  );
  if (dailyResult.rowsAffected && dailyResult.rowsAffected > 0) {
    await c.execute(
      "INSERT INTO stats (stat_key, stat_value) VALUES ('todayUsers', 1) ON DUPLICATE KEY UPDATE stat_value = stat_value + 1",
    );
  }

  // 5. Update location counter (await with 1.5s timeout — keeps total response under frontend 5s limit)
  if (ip) {
    try {
      const location = await Promise.race([
        lookupIpLocation(ip),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
      ]);
      if (location) {
        await c.execute(
          "INSERT INTO locations (province, city, visit_count) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE visit_count = visit_count + 1",
          [location.province, location.city],
        );
      }
    } catch (_e) {
      // Best-effort: location lookup failed, continue
    }
  }

  // 6. Return final stats
  return await getStats();
}

// ---------- Read locations ----------
async function getLocations() {
  const c = getConnection();
  const result = await c.execute(
    "SELECT province, city, visit_count FROM locations ORDER BY visit_count DESC LIMIT 50",
  );

  const locations: Array<{ province: string; city: string; count: number }> = [];
  if (result.rows) {
    for (const row of result.rows) {
      locations.push({
        province: row.province,
        city: row.city,
        count: Number(row.visit_count),
      });
    }
  }
  return locations;
}

// ---------- Reset all stats ----------
async function resetStats() {
  const c = getConnection();
  const today = getTodayShanghai();
  const todayNum = getTodayShanghaiNum();

  // Reset counters
  await c.execute(
    "INSERT INTO stats (stat_key, stat_value) VALUES ('totalVisits', 0) ON DUPLICATE KEY UPDATE stat_value = 0",
  );
  await c.execute(
    "INSERT INTO stats (stat_key, stat_value) VALUES ('totalUsers', 0) ON DUPLICATE KEY UPDATE stat_value = 0",
  );
  await c.execute(
    "INSERT INTO stats (stat_key, stat_value) VALUES ('todayVisits', 0) ON DUPLICATE KEY UPDATE stat_value = 0",
  );
  await c.execute(
    "INSERT INTO stats (stat_key, stat_value) VALUES ('todayUsers', 0) ON DUPLICATE KEY UPDATE stat_value = 0",
  );
  await c.execute(
    "INSERT INTO stats (stat_key, stat_value) VALUES ('lastDate', ?) ON DUPLICATE KEY UPDATE stat_value = ?",
    [todayNum, todayNum],
  );

  // Clear user records
  await c.execute("DELETE FROM all_users");
  await c.execute("DELETE FROM daily_users");
  await c.execute("DELETE FROM locations");
  // NOTE: ip_cache is NOT cleared (it's a cache, not stats data)

  return { totalVisits: 0, totalUsers: 0, todayVisits: 0, todayUsers: 0 };
}

// ---------- HTTP server ----------
Deno.serve(async (req: Request, info) => {
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
        database: "TiDB Cloud Serverless (MySQL)",
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

    // Ensure tables exist before any DB operation
    await ensureTables();

    if (path === "/api/stats" && req.method === "GET") {
      const data = await getStats();
      return jsonResponse({ success: true, data });
    }

    if (path === "/api/track" && req.method === "POST") {
      const body = await req.json();
      const userId = (body.userId as string) || crypto.randomUUID();
      const data = await trackVisit(userId, req, info);
      return jsonResponse({ success: true, data });
    }

    if (path === "/api/locations" && req.method === "GET") {
      const data = await getLocations();
      return jsonResponse({ success: true, data });
    }

    if (path === "/api/debug-ip" && req.method === "GET") {
      const ip = getClientIp(req, info);
      // Dump all headers for debugging
      const allHeaders: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        allHeaders[key] = value;
      });
      const location = ip ? await lookupIpLocation(ip) : null;
      return jsonResponse({
        success: true,
        data: {
          detectedIp: ip,
          isPrivate: ip ? isPrivateIp(ip) : null,
          location: location,
          remoteAddr: info?.remoteAddr?.hostname || null,
          allHeaders: allHeaders,
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
