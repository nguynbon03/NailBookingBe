import { PrismaClient } from "@prisma/client";
import { googleClientId, googleClientSecret } from "@/lib/google-auth";

export type GoogleCalendarSyncResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  eventId?: string | null;
  connectionEmail?: string | null;
  error?: string;
};

type PrismaLike = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

type BookingLike = {
  id: string;
  customerName: string;
  customerPhone?: string | null;
  customerEmail?: string | null;
  date: Date | string;
  time: string;
  status: string;
  totalPrice?: unknown;
  notes?: string | null;
  googleCalendarEventId?: string | null;
  staffId?: string | null;
  requestedStaffId?: string | null;
  staff?: { id?: string | null; name?: string | null; email?: string | null } | null;
  requestedStaff?: { id?: string | null; name?: string | null; email?: string | null } | null;
  services?: { service?: { name?: string | null; duration?: number | null } | null }[];
};

type GoogleConnection = {
  id: string;
  userId: string;
  staffId?: string | null;
  email: string;
  accessToken?: string | null;
  refreshToken?: string | null;
  scope?: string | null;
  calendarId?: string | null;
  syncEnabled: boolean;
  lastSyncAt?: Date | null;
  updatedAt?: Date | null;
};

type CalendarSettings = {
  syncEnabled: boolean;
  googleSyncEnabled: boolean;
  ownerEmail?: string | null;
  ownerCalendarId?: string | null;
};

const LONDON_TIMEZONE = "Europe/London";
const DEFAULT_CALENDAR_ID = "primary";
const SHOP_NAME = process.env.SHOP_NAME || "The Nail Lounge @ Stokesley";
const SHOP_ADDRESS = process.env.SHOP_ADDRESS || "33 High St, Stokesley, Middlesbrough, United Kingdom, TS9 5AD";
const PUBLIC_APP_URL = (process.env.PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "https://bookingnail.overpowers.agency").replace(/\/$/, "");
const GOOGLE_CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

function dayText(value: Date | string | null | undefined) {
  const date = value instanceof Date ? value : new Date(String(value || ""));
  return Number.isNaN(date.getTime()) ? String(value || "").slice(0, 10) : date.toISOString().slice(0, 10);
}

function timeText(value: unknown) {
  const text = String(value || "").trim();
  return /^\d{2}:\d{2}$/.test(text) ? `${text}:00` : "09:00:00";
}

function addMinutes(day: string, time: string, minutes: number) {
  const base = new Date(`${day}T${timeText(time)}Z`);
  if (Number.isNaN(base.getTime())) return `${day}T10:00:00`;
  base.setUTCMinutes(base.getUTCMinutes() + Math.max(15, minutes));
  return `${base.toISOString().slice(0, 10)}T${base.toISOString().slice(11, 19)}`;
}

function serviceNames(booking: BookingLike) {
  return (booking.services || []).map((item) => item.service?.name?.trim()).filter(Boolean).join(", ") || "Nail service";
}

function totalDurationMinutes(booking: BookingLike) {
  const total = (booking.services || []).reduce((sum, item) => sum + Number(item.service?.duration || 0), 0);
  return Math.max(30, total || 30);
}

function money(value: unknown) {
  const n = Number(value || 0);
  return `£${Number.isFinite(n) ? n.toFixed(2) : "0.00"}`;
}

function staffText(booking: BookingLike) {
  return booking.staff?.name || booking.requestedStaff?.name || "Unassigned";
}

function cleanMessage(value: unknown) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 500);
}

function bookingAdminUrl(bookingId: string) {
  return `${PUBLIC_APP_URL}/admin/bookings?highlight=${encodeURIComponent(bookingId)}`;
}

function eventPayload(booking: BookingLike, calendarId: string) {
  const day = dayText(booking.date);
  const startDateTime = `${day}T${String(booking.time || "09:00")}:00`;
  const endDateTime = addMinutes(day, booking.time, totalDurationMinutes(booking));
  const descriptionLines = [
    `Booking ID: ${booking.id}`,
    `Status: ${booking.status}`,
    `Customer: ${booking.customerName}`,
    `Phone: ${booking.customerPhone || "-"}`,
    `Email: ${booking.customerEmail || "-"}`,
    `Services: ${serviceNames(booking)}`,
    `Staff: ${staffText(booking)}`,
    `Total: ${money(booking.totalPrice)}`,
    booking.notes ? `Notes: ${cleanMessage(booking.notes)}` : "",
    `Open admin booking: ${bookingAdminUrl(booking.id)}`,
  ].filter(Boolean);

  return {
    summary: `${SHOP_NAME} · ${booking.customerName} · ${serviceNames(booking)}`,
    description: descriptionLines.join("\n"),
    location: SHOP_ADDRESS,
    start: {
      dateTime: startDateTime,
      timeZone: LONDON_TIMEZONE,
    },
    end: {
      dateTime: endDateTime,
      timeZone: LONDON_TIMEZONE,
    },
    reminders: {
      useDefault: true,
    },
    source: {
      title: SHOP_NAME,
      url: bookingAdminUrl(booking.id),
    },
    extendedProperties: {
      private: {
        nailbookingBookingId: booking.id,
        nailbookingCalendarId: calendarId,
        nailbookingStatus: booking.status,
      },
    },
  };
}

async function createLog(prisma: PrismaLike, data: { direction: string; status: string; message: string; bookingId?: string | null; staffId?: string | null }) {
  await (prisma as any).calendarSyncLog.create({
    data: {
      direction: data.direction,
      status: data.status,
      message: cleanMessage(data.message) || data.status,
      bookingId: data.bookingId || null,
      staffId: data.staffId || null,
    },
  }).catch(() => null);
}

async function currentSettings(prisma: PrismaLike): Promise<CalendarSettings | null> {
  return (prisma as any).calendarSyncSetting.findUnique({
    where: { id: "default" },
    select: { syncEnabled: true, googleSyncEnabled: true, ownerEmail: true, ownerCalendarId: true },
  }).catch(() => null);
}

async function activeConnection(prisma: PrismaLike, settings: CalendarSettings | null): Promise<GoogleConnection | null> {
  const ownerEmail = String(settings?.ownerEmail || "").trim().toLowerCase();
  const rows = await (prisma as any).googleCalendarConnection.findMany({
    where: { syncEnabled: true },
    orderBy: [{ updatedAt: "desc" }],
    take: 10,
  }).catch(() => []);
  if (!rows.length) return null;
  const exact = ownerEmail ? rows.find((item: GoogleConnection) => String(item.email || "").trim().toLowerCase() === ownerEmail) : null;
  return exact || rows[0] || null;
}

async function persistSyncState(prisma: PrismaLike, booking: BookingLike, patch: { eventId?: string | null; error?: string | null }) {
  await prisma.booking.update({
    where: { id: booking.id },
    data: {
      googleCalendarEventId: patch.eventId === undefined ? booking.googleCalendarEventId || null : patch.eventId,
      googleCalendarSyncedAt: patch.error ? null : new Date(),
      googleCalendarLastError: patch.error ? cleanMessage(patch.error) : null,
    } as any,
  }).catch(() => null);
}

async function markConnectionSynced(prisma: PrismaLike, connection: GoogleConnection) {
  const now = new Date();
  await Promise.all([
    (prisma as any).googleCalendarConnection.update({ where: { id: connection.id }, data: { lastSyncAt: now } }).catch(() => null),
    (prisma as any).calendarSyncSetting.update({ where: { id: "default" }, data: { lastSyncAt: now } }).catch(() => null),
  ]);
}

async function refreshAccessToken(prisma: PrismaLike, connection: GoogleConnection) {
  const clientId = googleClientId();
  const clientSecret = googleClientSecret();
  if (!clientId || !clientSecret || !connection.refreshToken) throw new Error("Google OAuth refresh is not configured");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: connection.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json().catch(() => ({} as any));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `Google refresh failed (${res.status})`);
  }
  await (prisma as any).googleCalendarConnection.update({
    where: { id: connection.id },
    data: {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || connection.refreshToken,
      scope: data.scope || connection.scope || null,
    },
  }).catch(() => null);
  return String(data.access_token);
}

async function ensureAccessToken(prisma: PrismaLike, connection: GoogleConnection) {
  if (connection.accessToken) return String(connection.accessToken);
  return refreshAccessToken(prisma, connection);
}

async function googleRequest(prisma: PrismaLike, connection: GoogleConnection, method: string, path: string, body?: unknown) {
  let token = await ensureAccessToken(prisma, connection);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await fetch(`${GOOGLE_CALENDAR_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status === 401 && connection.refreshToken && attempt === 0) {
      token = await refreshAccessToken(prisma, connection);
      continue;
    }

    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({} as any));
    if (!res.ok) throw new Error(data?.error?.message || data?.error_description || `Google Calendar HTTP ${res.status}`);
    return data;
  }

  throw new Error("Google Calendar authorization failed");
}

function syncEnabled(settings: CalendarSettings | null) {
  return Boolean(settings?.syncEnabled && settings?.googleSyncEnabled);
}

export async function syncBookingToGoogleCalendar(prisma: PrismaLike, booking: BookingLike): Promise<GoogleCalendarSyncResult> {
  const settings = await currentSettings(prisma);
  if (!syncEnabled(settings)) {
    return { ok: true, skipped: true, reason: "Google Calendar sync is disabled" };
  }
  if (!["CONFIRMED", "COMPLETED"].includes(String(booking.status || ""))) {
    return { ok: true, skipped: true, reason: "Only confirmed or completed bookings are mirrored" };
  }

  const connection = await activeConnection(prisma, settings);
  if (!connection) {
    await persistSyncState(prisma, booking, { error: "No active shop Gmail Calendar connection" });
    await createLog(prisma, { direction: "GOOGLE_OUTBOUND", status: "FAILED", message: `No active Gmail calendar connection for booking ${booking.id}`, bookingId: booking.id, staffId: booking.staffId || booking.requestedStaffId || null });
    return { ok: false, error: "No active shop Gmail Calendar connection" };
  }

  const calendarId = String(settings?.ownerCalendarId || connection.calendarId || DEFAULT_CALENDAR_ID).trim() || DEFAULT_CALENDAR_ID;
  const payload = eventPayload(booking, calendarId);

  try {
    const event = booking.googleCalendarEventId
      ? await googleRequest(prisma, connection, "PATCH", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(String(booking.googleCalendarEventId))}`, payload)
      : await googleRequest(prisma, connection, "POST", `/calendars/${encodeURIComponent(calendarId)}/events`, payload);

    const eventId = String(event?.id || booking.googleCalendarEventId || "").trim() || null;
    await persistSyncState(prisma, booking, { eventId, error: null });
    await markConnectionSynced(prisma, connection);
    await createLog(prisma, {
      direction: "GOOGLE_OUTBOUND",
      status: booking.googleCalendarEventId ? "UPDATED" : "CREATED",
      message: `Google Calendar ${booking.googleCalendarEventId ? "updated" : "created"} for ${booking.customerName} on ${dayText(booking.date)} at ${booking.time}`,
      bookingId: booking.id,
      staffId: booking.staffId || booking.requestedStaffId || null,
    });
    return { ok: true, eventId, connectionEmail: connection.email };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await persistSyncState(prisma, booking, { error: message });
    await createLog(prisma, {
      direction: "GOOGLE_OUTBOUND",
      status: "FAILED",
      message,
      bookingId: booking.id,
      staffId: booking.staffId || booking.requestedStaffId || null,
    });
    return { ok: false, error: message, connectionEmail: connection.email };
  }
}

export async function cancelGoogleCalendarBooking(prisma: PrismaLike, booking: BookingLike): Promise<GoogleCalendarSyncResult> {
  const settings = await currentSettings(prisma);
  if (!syncEnabled(settings)) {
    return { ok: true, skipped: true, reason: "Google Calendar sync is disabled" };
  }
  if (!booking.googleCalendarEventId) {
    return { ok: true, skipped: true, reason: "No Google Calendar event to remove" };
  }

  const connection = await activeConnection(prisma, settings);
  if (!connection) {
    await persistSyncState(prisma, booking, { error: "No active shop Gmail Calendar connection" });
    await createLog(prisma, { direction: "GOOGLE_OUTBOUND", status: "FAILED", message: `No active Gmail calendar connection to cancel booking ${booking.id}`, bookingId: booking.id, staffId: booking.staffId || booking.requestedStaffId || null });
    return { ok: false, error: "No active shop Gmail Calendar connection" };
  }

  const calendarId = String(settings?.ownerCalendarId || connection.calendarId || DEFAULT_CALENDAR_ID).trim() || DEFAULT_CALENDAR_ID;

  try {
    await googleRequest(prisma, connection, "DELETE", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(String(booking.googleCalendarEventId))}`);
    await persistSyncState(prisma, booking, { eventId: null, error: null });
    await markConnectionSynced(prisma, connection);
    await createLog(prisma, {
      direction: "GOOGLE_OUTBOUND",
      status: "CANCELLED",
      message: `Google Calendar event removed for ${booking.customerName} on ${dayText(booking.date)} at ${booking.time}`,
      bookingId: booking.id,
      staffId: booking.staffId || booking.requestedStaffId || null,
    });
    return { ok: true, eventId: null, connectionEmail: connection.email };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const treatMissingAsSuccess = /404|not found/i.test(message);
    if (treatMissingAsSuccess) {
      await persistSyncState(prisma, booking, { eventId: null, error: null });
      await markConnectionSynced(prisma, connection);
      await createLog(prisma, {
        direction: "GOOGLE_OUTBOUND",
        status: "CANCELLED",
        message: `Google Calendar event already missing for booking ${booking.id}; cleared local reference`,
        bookingId: booking.id,
        staffId: booking.staffId || booking.requestedStaffId || null,
      });
      return { ok: true, eventId: null, connectionEmail: connection.email };
    }

    await persistSyncState(prisma, booking, { error: message });
    await createLog(prisma, {
      direction: "GOOGLE_OUTBOUND",
      status: "FAILED",
      message,
      bookingId: booking.id,
      staffId: booking.staffId || booking.requestedStaffId || null,
    });
    return { ok: false, error: message, connectionEmail: connection.email };
  }
}
