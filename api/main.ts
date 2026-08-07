// api/main.ts - Deno Deploy server for ID formatter stats
// Uses Deno KV (built-in key-value store, no external database needed)
// Accessible in China via *.deno.dev domain

const kv = await Deno.openKv();

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
  return shanghaiTime.toISOString().slice(0, 10); // YYYY-MM-DD
}

// ---------- Read stats ----------
async function getStats() {
  const totalVisits = Number((await kv.get(["stats", "totalVisits"])).value ?? 0);
  const totalUsers = Number((await kv.get(["stats", "totalUsers"])).value ?? 0);
  const todayVisits = Number((await kv.get(["stats", "todayVisits"])).value ?? 0);
  const todayUsers = Number((await kv.get(["stats", "todayUsers"])).value ?? 0);
  return { totalVisits, totalUsers, todayVisits, todayUsers };
}

// ---------- Track visit (atomic increment + dedup) ----------
async function trackVisit(userId: string): Promise<{
  totalVisits: number;
  totalUsers: number;
  todayVisits: number;
  todayUsers: number;
}> {
  const today = getTodayShanghai();

  // Read current state in parallel
  const [lastDateRes, userExistsRes, todayUserExistsRes, statsRes] = await Promise.all([
    kv.get<string>(["stats", "lastDate"]),
    kv.get(["allUsers", userId]),
    kv.get(["dailyUsers", today, userId]),
    kv.get<number>(["stats", "totalVisits"]),
  ]);

  const lastDate = lastDateRes.value;
  const userExists = userExistsRes.value !== null;
  const todayUserExists = todayUserExistsRes.value !== null;
  const isNewDay = lastDate !== today;

  // Read current counters
  const totalVisits = Number((await kv.get(["stats", "totalVisits"])).value ?? 0);
  const totalUsers = Number((await kv.get(["stats", "totalUsers"])).value ?? 0);
  const todayVisits = isNewDay ? 0 : Number((await kv.get(["stats", "todayVisits"])).value ?? 0);
  const todayUsers = isNewDay ? 0 : Number((await kv.get(["stats", "todayUsers"])).value ?? 0);

  // Compute new values
  const newTotalVisits = totalVisits + 1;
  const newTodayVisits = todayVisits + 1;
  const newTotalUsers = userExists ? totalUsers : totalUsers + 1;
  const newTodayUsers = todayUserExists ? todayUsers : todayUsers + 1;

  // Atomic write (all or nothing)
  const atomic = kv.atomic()
    .set(["stats", "totalVisits"], newTotalVisits)
    .set(["stats", "todayVisits"], newTodayVisits)
    .set(["stats", "totalUsers"], newTotalUsers)
    .set(["stats", "todayUsers"], newTodayUsers)
    .set(["stats", "lastDate"], today);

  if (!userExists) {
    atomic.set(["allUsers", userId], true);
  }
  if (!todayUserExists) {
    atomic.set(["dailyUsers", today, userId], true);
  }

  const result = await atomic.commit();

  if (!result.ok) {
    // Retry on conflict (rare for low-traffic site)
    return trackVisit(userId);
  }

  return {
    totalVisits: newTotalVisits,
    totalUsers: newTotalUsers,
    todayVisits: newTodayVisits,
    todayUsers: newTodayUsers,
  };
}

// ---------- HTTP server ----------
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  // Health check
  if (path === "/api/health") {
    return jsonResponse({ success: true, message: "ok" });
  }

  // Get stats
  if (path === "/api/stats" && req.method === "GET") {
    try {
      const data = await getStats();
      return jsonResponse({ success: true, data });
    } catch (e) {
      return jsonResponse({ success: false, error: String(e) }, 500);
    }
  }

  // Track visit
  if (path === "/api/track" && req.method === "POST") {
    try {
      const body = await req.json();
      const userId = body.userId || crypto.randomUUID();
      const data = await trackVisit(userId);
      return jsonResponse({ success: true, data });
    } catch (e) {
      return jsonResponse({ success: false, error: String(e) }, 400);
    }
  }

  // 404
  return jsonResponse({ success: false, error: "Not found" }, 404);
});
