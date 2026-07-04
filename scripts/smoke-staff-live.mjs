const baseUrl = (process.env.BASE_URL || "https://bookingnail.overpowers.agency").replace(/\/$/, "");
const email = process.env.STAFF_EMAIL || "emma@nailbooking.com";
const password = process.env.STAFF_PASSWORD || "staff123";

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
  if (!data?.token) throw new Error("Staff login did not return a token");
  return data.token;
}

async function authed(path, token) {
  return request(path, { headers: { Authorization: "Bearer " + token } });
}

const token = await login();
const me = await authed("/api/auth/me", token);
const dashboard = await authed("/api/staff/bookings", token);
const availability = await authed("/api/staff/availability", token);
const notifications = await authed("/api/notifications?audience=staff&limit=10", token);
const leave = await authed("/api/staff/leave", token);

const checks = {
  roleIsStaff: me?.user?.role === "STAFF",
  hasStaffProfile: Boolean(dashboard?.staffProfile?.id),
  hasRevenueStats: ["revenueToday", "revenueWeek", "revenueMonth", "revenueTotal"].every((key) => typeof dashboard?.stats?.[key] === "number"),
  hasBookingArrays: Array.isArray(dashboard?.availableBookings) && Array.isArray(dashboard?.myBookings) && Array.isArray(dashboard?.historyBookings),
  hasAvailabilityArray: Array.isArray(availability?.availability),
  hasNotificationArray: Array.isArray(notifications?.notifications),
  hasLeaveArray: Array.isArray(leave?.requests),
};

const failed = Object.entries(checks).filter(([, ok]) => !ok);
const summary = {
  baseUrl,
  checks,
  metrics: {
    openBookings: dashboard?.availableBookings?.length || 0,
    assignedBookings: dashboard?.myBookings?.length || 0,
    historyBookings: dashboard?.historyBookings?.length || 0,
    unreadNotifications: notifications?.notifications?.filter?.((item) => !item.read)?.length || 0,
    availabilitySlots: availability?.availability?.length || 0,
    pendingLeaveRequests: leave?.requests?.filter?.((item) => item.status === "PENDING")?.length || 0,
  },
  revenue: dashboard?.stats || {},
  samples: {
    notificationTypes: (notifications?.notifications || []).slice(0, 5).map((item) => item.type),
    availabilityPreview: (availability?.availability || []).slice(0, 3),
  },
};

console.log(JSON.stringify(summary, null, 2));
if (failed.length) {
  console.error(`Smoke staff failed: ${failed.map(([name]) => name).join(", ")}`);
  process.exit(1);
}
