import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateAssistantReply, type ChatMessage, type ChatbotMode, type ResponseLanguage } from "@/lib/chatbot";
import { shouldCountRevenue } from "@/lib/booking-workflow";
import { getAuthUser, isAdminRole } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = { messages?: ChatMessage[]; page?: string; imageDataUrl?: string | null; language?: string; responseLanguage?: string; shopLanguage?: string };

type SimpleBooking = {
  id: string;
  customerName: string;
  date: Date;
  time: string;
  status: string;
  totalPrice: unknown;
  staffId: string | null;
  staff?: { name: string } | null;
  requestedStaff?: { name: string } | null;
  services?: Array<{ service?: { name?: string | null } | null }>;
};

function detectMode(_page?: string, role?: string | null): ChatbotMode {
  if (isAdminRole(role)) return "admin";
  if (role === "STAFF") return "staff";
  return "customer";
}

function flagEnv(keys: string[], fallback = false) {
  for (const key of keys) {
    const value = String(process.env[key] || "").trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(value)) return true;
    if (["0", "false", "no", "off"].includes(value)) return false;
  }
  return fallback;
}

function chatbotEnabled() {
  const edition = String(process.env.APP_EDITION || "pro").trim().toLowerCase();
  return flagEnv(["CHATBOT_ENABLED", "AI_CHATBOT_ENABLED"], edition !== "basic");
}

function responseLanguageFrom(value?: string | null): ResponseLanguage | null {
  const language = String(value || "").trim().toLowerCase();
  if (["vi", "vn", "vietnamese", "tiếng việt", "tieng viet"].includes(language)) return "vi";
  if (["en", "english"].includes(language)) return "en";
  return null;
}

function detectVietnamese(text: string) {
  return /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i.test(text);
}

function resolveResponseLanguage(body: Body, messages: ChatMessage[]): ResponseLanguage {
  const explicit = responseLanguageFrom(body.responseLanguage || body.language || body.shopLanguage);
  if (explicit) return explicit;
  const configured = responseLanguageFrom(process.env.SHOP_LANGUAGE || process.env.CHATBOT_RESPONSE_LANGUAGE || process.env.DEFAULT_LANGUAGE);
  if (configured) return configured;
  const latestUser = [...messages].reverse().find((item) => item.role === "user")?.content || "";
  return detectVietnamese(latestUser) ? "vi" : "en";
}

function startOfDay(base = new Date()) {
  const date = new Date(base);
  date.setHours(0, 0, 0, 0);
  return date;
}

function endOfDay(base = new Date()) {
  const date = new Date(base);
  date.setHours(23, 59, 59, 999);
  return date;
}

function startOfMonth(base = new Date()) {
  const date = new Date(base.getFullYear(), base.getMonth(), 1);
  date.setHours(0, 0, 0, 0);
  return date;
}

function money(value: number) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(Number(value || 0));
}

function shortDay(value: Date | string) {
  try {
    return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "2-digit", month: "short" }).format(new Date(value));
  } catch {
    return String(value);
  }
}

function serviceNames(booking: Pick<SimpleBooking, "services">) {
  return (booking.services || []).map((item) => item.service?.name).filter(Boolean).join(", ");
}

function bookingLine(booking: SimpleBooking) {
  const services = serviceNames(booking);
  const staffLabel = booking.staff?.name || booking.requestedStaff?.name || "Unassigned";
  return `${shortDay(booking.date)} ${booking.time} — ${booking.customerName}${services ? ` (${services})` : ""} [${booking.status}] · ${staffLabel}`;
}

function sumRevenue(bookings: Array<Pick<SimpleBooking, "status" | "totalPrice">>) {
  return bookings.reduce((sum, booking) => sum + (shouldCountRevenue(String(booking.status || "")) ? Number(booking.totalPrice || 0) : 0), 0);
}

async function buildAdminSnapshot() {
  const todayStart = startOfDay();
  const todayEnd = endOfDay();
  const monthStart = startOfMonth();
  const now = new Date();

  const [
    todayBookings,
    monthBookings,
    activeStaffCount,
    totalStaffCount,
    unreadAdminTickets,
    pendingLeaveCount,
    pendingLeaves,
    approvedUpcomingLeaves,
    totalUsers,
    adminUsers,
    managerUsers,
    staffUsers,
    customerUsers,
    verifiedEmailUsers,
    verifiedPhoneUsers,
    totalPromoCodes,
    activePromoCodes,
    expiredPromoCodes,
    promoCodes,
    totalServices,
    activeServices,
    calendarConnections,
    enabledCalendarConnections,
  ] = await Promise.all([
    prisma.booking.findMany({
      where: { archivedAt: null, date: { gte: todayStart, lte: todayEnd } },
      orderBy: [{ time: "asc" }, { createdAt: "asc" }],
      take: 12,
      select: {
        id: true,
        customerName: true,
        date: true,
        time: true,
        status: true,
        totalPrice: true,
        staffId: true,
        staff: { select: { name: true } },
        requestedStaff: { select: { name: true } },
        services: { select: { service: { select: { name: true } } } },
      },
    }),
    prisma.booking.findMany({
      where: { archivedAt: null, date: { gte: monthStart, lte: todayEnd } },
      select: { id: true, customerName: true, date: true, time: true, status: true, totalPrice: true, staffId: true },
    }),
    prisma.staff.count({ where: { active: true } }),
    prisma.staff.count(),
    prisma.notification.count({ where: { audience: "ADMIN", read: false } }),
    prisma.staffLeaveRequest.count({ where: { status: "PENDING" } }),
    prisma.staffLeaveRequest.findMany({
      where: { status: "PENDING" },
      include: { staff: { select: { name: true, role: true } } },
      orderBy: [{ startDate: "asc" }, { createdAt: "desc" }],
      take: 6,
    }),
    prisma.staffLeaveRequest.findMany({
      where: { status: "APPROVED", endDate: { gte: todayStart } },
      include: { staff: { select: { name: true, role: true } } },
      orderBy: [{ startDate: "asc" }, { createdAt: "desc" }],
      take: 6,
    }),
    prisma.user.count(),
    prisma.user.count({ where: { role: "ADMIN" } }),
    prisma.user.count({ where: { role: "MANAGER" } }),
    prisma.user.count({ where: { role: "STAFF" } }),
    prisma.user.count({ where: { role: "CUSTOMER" } }),
    prisma.user.count({ where: { emailVerifiedAt: { not: null } } }),
    prisma.user.count({ where: { phoneVerifiedAt: { not: null } } }),
    prisma.promoCode.count(),
    prisma.promoCode.count({
      where: {
        active: true,
        OR: [{ startsAt: null }, { startsAt: { lte: now } }],
        AND: [{ OR: [{ endsAt: null }, { endsAt: { gte: now } }] }],
      },
    }),
    prisma.promoCode.count({ where: { endsAt: { lt: now } } }),
    prisma.promoCode.findMany({ orderBy: [{ active: "desc" }, { usedCount: "desc" }, { createdAt: "desc" }], take: 8 }),
    prisma.service.count(),
    prisma.service.count({ where: { active: true } }),
    prisma.googleCalendarConnection.count(),
    prisma.googleCalendarConnection.count({ where: { syncEnabled: true } }),
  ]);

  const todayRevenue = sumRevenue(todayBookings);
  const monthRevenue = sumRevenue(monthBookings);
  const todayPending = todayBookings.filter((item) => item.status === "PENDING").length;
  const todayConfirmed = todayBookings.filter((item) => item.status === "CONFIRMED").length;
  const todayCompleted = todayBookings.filter((item) => item.status === "COMPLETED").length;
  const todayCancelled = todayBookings.filter((item) => item.status === "CANCELLED").length;
  const unassignedCount = todayBookings.filter((item) => !item.staffId).length;
  const usedPromoCodes = promoCodes.reduce((sum, promo) => sum + Number(promo.usedCount || 0), 0);
  const staffRatings = await prisma.staffReview.groupBy({
    by: ["staffId"],
    _avg: { rating: true },
    _count: { rating: true },
    orderBy: [{ _avg: { rating: "desc" } }, { _count: { rating: "desc" } }],
    take: 5,
  }).catch(() => []);
  const ratedStaff = staffRatings.length
    ? await prisma.staff.findMany({ where: { id: { in: staffRatings.map((item) => item.staffId) } }, select: { id: true, name: true, role: true } }).catch(() => [])
    : [];
  const ratedStaffById = new Map(ratedStaff.map((item) => [item.id, item]));

  const lines = [
    "ADMIN LIVE DATABASE CONTEXT",
    `Today revenue counted: ${money(todayRevenue)}`,
    `Month revenue counted: ${money(monthRevenue)}`,
    `Today bookings: ${todayBookings.length} total (${todayPending} pending, ${todayConfirmed} confirmed, ${todayCompleted} completed, ${todayCancelled} cancelled)` ,
    `Unassigned bookings today: ${unassignedCount}`,
    `Accounts total: ${totalUsers} (admins ${adminUsers}, managers ${managerUsers}, staff users ${staffUsers}, customers ${customerUsers})`,
    `Verified accounts: email ${verifiedEmailUsers}, phone ${verifiedPhoneUsers}`,
    `Staff profiles: ${activeStaffCount} active / ${totalStaffCount} total`,
    `Services: ${activeServices} active / ${totalServices} total`,
    `Promo codes: ${totalPromoCodes} total, ${activePromoCodes} active now, ${expiredPromoCodes} expired, ${usedPromoCodes} total uses among top codes`,
    `Google Calendar connections: ${enabledCalendarConnections} enabled / ${calendarConnections} total`,
    `Unread admin tickets: ${unreadAdminTickets}`,
    `Pending leave tickets: ${pendingLeaveCount}`,
  ];

  if (promoCodes.length) {
    lines.push("Top promo codes:");
    promoCodes.slice(0, 5).forEach((promo) => {
      const remaining = promo.usageLimit == null ? "unlimited" : String(Math.max(0, Number(promo.usageLimit) - Number(promo.usedCount || 0)));
      lines.push(`- ${promo.code}: ${promo.discountPercent}% · ${promo.active ? "active" : "inactive"} · used ${promo.usedCount}${promo.usageLimit == null ? "" : `/${promo.usageLimit}`} · remaining ${remaining}`);
    });
  }

  if (staffRatings.length) {
    lines.push("Staff rating leaderboard (customer feedback, 1-5 stars):");
    staffRatings.forEach((rating) => {
      const staff = ratedStaffById.get(rating.staffId);
      if (!staff) return;
      lines.push(`- ${staff.name} (${staff.role}): ${Number(rating._avg.rating || 0).toFixed(2)}/5 from ${rating._count.rating} review(s)`);
    });
  } else {
    lines.push("Staff rating leaderboard: no customer staff feedback submitted yet.");
  }

  if (todayBookings.length) {
    lines.push("Next bookings today:");
    todayBookings.slice(0, 6).forEach((booking) => lines.push(`- ${bookingLine(booking as SimpleBooking)}`));
  }

  if (pendingLeaves.length) {
    lines.push("Pending leave queue:");
    pendingLeaves.forEach((leave) => lines.push(`- ${leave.staff.name}: ${shortDay(leave.startDate)} → ${shortDay(leave.endDate)} · ${leave.reason}`));
  }

  if (approvedUpcomingLeaves.length) {
    lines.push("Approved/current leave:");
    approvedUpcomingLeaves.forEach((leave) => lines.push(`- ${leave.staff.name}: ${shortDay(leave.startDate)} → ${shortDay(leave.endDate)} · ${leave.reason}`));
  }

  return lines.join("\n");
}

async function buildStaffSnapshot(authUser: Awaited<ReturnType<typeof getAuthUser>>) {
  if (!authUser?.email) return "Staff login was not detected in the current request.";

  const staffProfile = await prisma.staff.findUnique({
    where: { email: authUser.email },
    select: { id: true, name: true, role: true },
  });

  if (!staffProfile) {
    return `Staff-linked profile was not found for ${authUser.email}.`;
  }

  const todayStart = startOfDay();
  const todayEnd = endOfDay();
  const monthStart = startOfMonth();
  const weekday = todayStart.getDay();

  const [todayBookings, monthBookings, upcomingBookings, activeLeaves, todayAvailability, staffRating] = await Promise.all([
    prisma.booking.findMany({
      where: { archivedAt: null, staffId: staffProfile.id, date: { gte: todayStart, lte: todayEnd } },
      orderBy: [{ time: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        customerName: true,
        date: true,
        time: true,
        status: true,
        totalPrice: true,
        staffId: true,
        services: { select: { service: { select: { name: true } } } },
      },
    }),
    prisma.booking.findMany({
      where: { archivedAt: null, staffId: staffProfile.id, date: { gte: monthStart, lte: todayEnd } },
      orderBy: [{ date: "desc" }, { time: "desc" }],
      select: {
        id: true,
        customerName: true,
        date: true,
        time: true,
        status: true,
        totalPrice: true,
        staffId: true,
        services: { select: { service: { select: { name: true } } } },
      },
    }),
    prisma.booking.findMany({
      where: { archivedAt: null, staffId: staffProfile.id, status: "CONFIRMED", date: { gte: todayStart } },
      orderBy: [{ date: "asc" }, { time: "asc" }],
      take: 5,
      select: {
        id: true,
        customerName: true,
        date: true,
        time: true,
        status: true,
        totalPrice: true,
        staffId: true,
        services: { select: { service: { select: { name: true } } } },
      },
    }),
    prisma.staffLeaveRequest.findMany({
      where: { staffId: staffProfile.id, endDate: { gte: todayStart } },
      orderBy: [{ startDate: "asc" }, { createdAt: "desc" }],
      take: 5,
    }),
    prisma.staffAvailability.findMany({
      where: {
        staffId: staffProfile.id,
        active: true,
        OR: [
          { date: { gte: todayStart, lte: todayEnd } },
          { date: null, dayOfWeek: weekday },
        ],
      },
      orderBy: [{ date: "asc" }, { startTime: "asc" }],
      select: { startTime: true, endTime: true, date: true, dayOfWeek: true },
    }),
    prisma.staffReview.aggregate({ where: { staffId: staffProfile.id }, _avg: { rating: true }, _count: { rating: true } }),
  ]);

  const todayRevenue = sumRevenue(todayBookings);
  const monthRevenue = sumRevenue(monthBookings);
  const pendingLeaveCount = activeLeaves.filter((leave) => leave.status === "PENDING").length;
  const approvedLeaveCount = activeLeaves.filter((leave) => leave.status === "APPROVED").length;

  const lines = [
    "STAFF LIVE SNAPSHOT",
    `Staff: ${staffProfile.name} (${staffProfile.role})`,
    `Today's jobs: ${todayBookings.length}`,
    `Today's counted revenue: ${money(todayRevenue)}`,
    `Month counted revenue: ${money(monthRevenue)}`,
    `Pending leave tickets: ${pendingLeaveCount}`,
    `Approved/current leave tickets: ${approvedLeaveCount}`,
    `Customer feedback rating: ${staffRating._count.rating ? `${Number(staffRating._avg.rating || 0).toFixed(2)}/5 from ${staffRating._count.rating} review(s)` : "No customer reviews yet"}`,
    `Today's availability: ${todayAvailability.length ? todayAvailability.map((slot) => `${slot.startTime}-${slot.endTime}`).join(", ") : "No availability added yet"}`,
  ];

  if (upcomingBookings.length) {
    lines.push("Next assigned bookings:");
    upcomingBookings.slice(0, 4).forEach((booking) => lines.push(`- ${bookingLine(booking as SimpleBooking)}`));
  }

  if (activeLeaves.length) {
    lines.push("Leave status:");
    activeLeaves.forEach((leave) => lines.push(`- ${leave.status}: ${shortDay(leave.startDate)} → ${shortDay(leave.endDate)} · ${leave.reason}`));
  }

  return lines.join("\n");
}

async function buildCustomerSnapshot(authUser: Awaited<ReturnType<typeof getAuthUser>>) {
  if (!authUser?.id) return "No logged-in customer snapshot is available in the current request.";

  const todayStart = startOfDay();

  const [upcomingBookings, recentBookings] = await Promise.all([
    prisma.booking.findMany({
      where: { archivedAt: null, userId: authUser.id, date: { gte: todayStart } },
      orderBy: [{ date: "asc" }, { time: "asc" }],
      take: 5,
      select: {
        id: true,
        customerName: true,
        date: true,
        time: true,
        status: true,
        totalPrice: true,
        staffId: true,
        staff: { select: { name: true } },
        services: { select: { service: { select: { name: true } } } },
      },
    }),
    prisma.booking.findMany({
      where: { archivedAt: null, userId: authUser.id },
      orderBy: [{ date: "desc" }, { time: "desc" }],
      take: 3,
      select: {
        id: true,
        customerName: true,
        date: true,
        time: true,
        status: true,
        totalPrice: true,
        staffId: true,
        staff: { select: { name: true } },
        services: { select: { service: { select: { name: true } } } },
      },
    }),
  ]);

  if (!upcomingBookings.length && !recentBookings.length) {
    return "Logged-in customer with no saved bookings yet.";
  }

  const lines = ["CUSTOMER LIVE SNAPSHOT"];
  if (upcomingBookings.length) {
    lines.push(`Upcoming bookings: ${upcomingBookings.length}`);
    upcomingBookings.forEach((booking) => lines.push(`- ${bookingLine(booking as SimpleBooking)}`));
  }
  if (recentBookings.length) {
    lines.push("Recent bookings:");
    recentBookings.forEach((booking) => lines.push(`- ${bookingLine(booking as SimpleBooking)}`));
  }
  return lines.join("\n");
}

export async function POST(req: NextRequest) {
  try {
    if (!chatbotEnabled()) {
      return NextResponse.json({ error: "Chat assistant is disabled for this plan" }, { status: 404 });
    }
    const body = (await req.json().catch(() => ({}))) as Body;
    const messages = Array.isArray(body.messages)
      ? body.messages
          .map((item) => ({ role: item?.role, content: String(item?.content || "").trim() }))
          .filter((item) => (item.role === "user" || item.role === "assistant" || item.role === "system") && item.content)
      : [];

    if (!messages.length) return NextResponse.json({ error: "Message is required" }, { status: 400 });

    const [authUser, services] = await Promise.all([
      getAuthUser(req),
      prisma.service.findMany({
        where: { active: true },
        orderBy: [{ category: "asc" }, { name: "asc" }],
        select: { name: true, category: true, price: true, duration: true, description: true },
      }).catch(() => []),
    ]);

    const servicesText = services
      .map((service) => {
        const price = Number(service.price || 0).toFixed(2);
        const note = service.description ? ` — ${service.description}` : "";
        return `- ${service.name} (${service.category}) · £${price} · ${service.duration} min${note}`;
      })
      .join("\n");

    const mode = detectMode(body.page, authUser?.role);
    const extraContext = mode === "admin"
      ? await buildAdminSnapshot()
      : mode === "staff"
        ? await buildStaffSnapshot(authUser)
        : await buildCustomerSnapshot(authUser);

    const responseLanguage = resolveResponseLanguage(body, messages);

    const result = await generateAssistantReply({
      messages,
      page: body.page,
      servicesText,
      mode,
      extraContext,
      imageDataUrl: body.imageDataUrl,
      responseLanguage,
    });

    return NextResponse.json({ ...result, mode, responseLanguage });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Chat assistant failed" },
      { status: 500 },
    );
  }
}
