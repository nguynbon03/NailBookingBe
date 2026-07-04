const baseUrl = (process.env.BASE_URL || "https://bookingnail.overpowers.agency").replace(/\/$/, "");
const email = process.env.STAFF_EMAIL || process.env.ADMIN_EMAIL || "admin";
const password = process.env.STAFF_PASSWORD || process.env.ADMIN_PASSWORD || "admin123";

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
  return request(path, { headers: { Authorization: `Bearer ${token}` } });
}

async function attemptAuthed(path, token) {
  try {
    return { ok: true, data: await authed(path, token), status: 200 };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

const token = await login();
const me = await authed("/api/auth/me", token);
const dashboard = await authed("/api/staff/bookings", token);
const availabilityResp = await attemptAuthed("/api/staff/availability", token);
const notificationsResp = await attemptAuthed("/api/notifications?audience=staff&limit=10", token);
const leaveResp = await attemptAuthed("/api/staff/leave", token);
const availability = availabilityResp.data;
const notifications = notificationsResp.data;
const leave = leaveResp.data;
const currentRole = me?.user?.role;
const staffProfileRequired = currentRole === "STAFF";

const checks = {
  roleAllowed: ["STAFF", "ADMIN", "MANAGER"].includes(currentRole),
  hasStaffProfile: !staffProfileRequired || Boolean(dashboard?.staffProfile?.id),
  hasRevenueStats: ["revenueToday", "revenueWeek", "revenueMonth", "revenueTotal"].every((key) => typeof dashboard?.stats?.[key] === "number"),
  hasBookingArrays: Array.isArray(dashboard?.availableBookings) && Array.isArray(dashboard?.myBookings) && Array.isArray(dashboard?.historyBookings),
  hasAvailabilityArray: availabilityResp.ok ? Array.isArray(availability?.availability) : /Staff profile not found/.test(availabilityResp.error || ""),
  hasNotificationArray: notificationsResp.ok ? Array.isArray(notifications?.notifications) : false,
  hasLeaveArray: leaveResp.ok ? Array.isArray(leave?.requests) : /Staff profile not found/.test(leaveResp.error || ""),
};

const failed = Object.entries(checks).filter(([, ok]) => !ok);
const summary = {
  baseUrl,
  checks,
  metrics: {
    role: currentRole,
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
    availabilityGuard: availabilityResp.ok ? null : availabilityResp.error,
  },
};

console.log(JSON.stringify(summary, null, 2));
if (failed.length) {
  console.error(`Smoke staff failed: ${failed.map(([name]) => name).join(", ")}`);
  process.exit(1);
}
