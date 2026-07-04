const baseUrl = (process.env.BASE_URL || "https://bookingnail.overpowers.agency").replace(/\/$/, "");
const email = process.env.ADMIN_EMAIL || "admin";
const password = process.env.ADMIN_PASSWORD || "admin123";

async function request(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${path} -> HTTP ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function login() {
  const data = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (!data?.token) throw new Error("Admin login did not return a token");
  return data.token;
}

async function authed(path, token) {
  return request(path, { headers: { Authorization: "Bearer " + token } });
}

const token = await login();
const me = await authed("/api/auth/me", token);
const calendarSync = await authed("/api/admin/calendar-sync", token);
const revenueWeek = await authed("/api/admin/reports/revenue?period=week", token);
const inbox = await authed("/api/notifications?audience=admin&limit=10", token);
const bookings = await authed("/api/bookings?status=CONFIRMED", token);

const checks = {
  roleIsAdmin: me?.user?.role === "ADMIN",
  hasCalendarConnectUrl: Boolean(calendarSync?.env?.google?.connectUrl),
  hasCalendarSettings: Boolean(calendarSync?.settings && typeof calendarSync.settings.syncEnabled === "boolean"),
  hasStaffRevenueTotals: Array.isArray(revenueWeek?.staffTotals),
  hasRevenueSummary: typeof revenueWeek?.summary?.totalRevenue === "number",
  hasAdminNotificationsArray: Array.isArray(inbox?.notifications),
  hasBookingsArray: Array.isArray(bookings?.bookings),
};

const failed = Object.entries(checks).filter(([, ok]) => !ok);
const summary = {
  baseUrl,
  checks,
  metrics: {
    calendarConnections: calendarSync?.connections?.length || 0,
    inboxCount: inbox?.notifications?.length || 0,
    confirmedBookings: bookings?.bookings?.length || 0,
    weekRevenue: revenueWeek?.summary?.totalRevenue || 0,
    staffRevenueRows: revenueWeek?.staffTotals?.length || 0,
  },
  samples: {
    googleRedirectUri: calendarSync?.env?.google?.redirectUri || null,
    topStaffRevenue: revenueWeek?.staffTotals?.slice?.(0, 3) || [],
    inboxTypes: (inbox?.notifications || []).slice(0, 5).map((item) => item.type),
  },
};

console.log(JSON.stringify(summary, null, 2));
if (failed.length) {
  console.error(`Smoke admin failed: ${failed.map(([name]) => name).join(", ")}`);
  process.exit(1);
}
