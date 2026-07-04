import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { isStaffAvailableAndFree } from "@/lib/availability";
import { bookingInclude, updateBookingStatusWithRevenue } from "@/lib/booking-workflow";
import { queueCustomerBookingNotification, deliverPendingCustomerNotifications } from "@/lib/customer-notifications";
import { googleClientId, googleClientSecret } from "@/lib/google-auth";
import { queueCustomerWebsiteNotification, queueOwnerBookingEmail, queueStaffBookingEmail } from "@/lib/internal-notifications";
import { notifyBookingStatusChanged } from "@/lib/notifications";

export type GoogleCalendarSyncResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  eventId?: string | null;
  connectionEmail?: string | null;
  error?: string;
};

export type GoogleCalendarWatchResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  channelId?: string | null;
  expiresAt?: string | null;
  error?: string;
};

export type GoogleCalendarWebhookResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  processed?: number;
  synced?: number;
  conflicts?: number;
  ignored?: number;
  error?: string;
};

type PrismaLike = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

type BookingLike = {
  id: string;
  userId?: string | null;
  customerName: string;
  customerPhone?: string | null;
  customerEmail?: string | null;
  date: Date | string;
  time: string;
  status: string;
  totalPrice?: unknown;
  notes?: string | null;
  cancellationReason?: string | null;
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
  watchChannelId?: string | null;
  watchResourceId?: string | null;
  watchExpiration?: Date | string | null;
  syncToken?: string | null;
  lastWebhookAt?: Date | null;
  lastSyncAt?: Date | null;
  updatedAt?: Date | null;
};

type CalendarSettings = {
  syncEnabled: boolean;
  googleSyncEnabled: boolean;
  ownerEmail?: string | null;
  ownerCalendarId?: string | null;
};

type GoogleEventLike = {
  id?: string | null;
  status?: string | null;
  summary?: string | null;
  start?: { dateTime?: string | null; date?: string | null } | null;
  end?: { dateTime?: string | null; date?: string | null } | null;
  extendedProperties?: { private?: Record<string, string> | null } | null;
};

const LONDON_TIMEZONE = "Europe/London";
const DEFAULT_CALENDAR_ID = "primary";
const SHOP_NAME = process.env.SHOP_NAME || "The Nail Lounge @ Stokesley";
const SHOP_ADDRESS = process.env.SHOP_ADDRESS || "33 High St, Stokesley, Middlesbrough, United Kingdom, TS9 5AD";
const PUBLIC_APP_URL = (process.env.PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "https://bookingnail.overpowers.agency").replace(/\/$/, "");
const GOOGLE_CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
const GOOGLE_WATCH_TTL_SECONDS = 60 * 60 * 24 * 7;
const WATCH_REFRESH_BUFFER_MS = 10 * 60 * 1000;

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

function calendarIdFor(settings: CalendarSettings | null, connection: GoogleConnection) {
  return String(settings?.ownerCalendarId || connection.calendarId || DEFAULT_CALENDAR_ID).trim() || DEFAULT_CALENDAR_ID;
}

function parseWatchExpiration(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    const byMs = new Date(numeric);
    if (!Number.isNaN(byMs.getTime())) return byMs;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function watchIsFresh(connection: GoogleConnection) {
  const expiresAt = parseWatchExpiration(connection.watchExpiration);
  return Boolean(
    connection.watchChannelId &&
      connection.watchResourceId &&
      expiresAt &&
      expiresAt.getTime() - WATCH_REFRESH_BUFFER_MS > Date.now()
  );
}

function londonDateTimeParts(value: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: LONDON_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(value);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    day: `${lookup.year}-${lookup.month}-${lookup.day}`,
    time: `${lookup.hour}:${lookup.minute}`,
  };
}

function parseGoogleEventSlot(event: GoogleEventLike) {
  const start = String(event.start?.dateTime || "").trim();
  if (!start) return null;
  const parsed = new Date(start);
  if (Number.isNaN(parsed.getTime())) return null;
  return londonDateTimeParts(parsed);
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

async function currentConnection(prisma: PrismaLike, connectionId: string): Promise<GoogleConnection | null> {
  return (prisma as any).googleCalendarConnection.findUnique({ where: { id: connectionId } }).catch(() => null);
}

async function persistSyncState(prisma: PrismaLike, booking: BookingLike, patch: { eventId?: string | null; error?: string | null }) {
  await (prisma as any).booking.update({
    where: { id: booking.id },
    data: {
      googleCalendarEventId: patch.eventId === undefined ? booking.googleCalendarEventId || null : patch.eventId,
      googleCalendarSyncedAt: patch.error ? null : new Date(),
      googleCalendarLastError: patch.error ? cleanMessage(patch.error) : null,
    },
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
    throw new Error(data.error_description || data.error || `Google refresh failed (HTTP ${res.status})`);
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
        Authorization: "Bearer " + token,
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
    if (!res.ok) {
      throw new Error(`${data?.error?.message || data?.error_description || "Google Calendar request failed"} (HTTP ${res.status})`);
    }
    return data;
  }

  throw new Error("Google Calendar authorization failed");
}

async function listGoogleEvents(prisma: PrismaLike, connection: GoogleConnection, calendarId: string, syncToken?: string | null) {
  const items: GoogleEventLike[] = [];
  let pageToken: string | null = null;
  let nextSyncToken: string | null = syncToken ? String(syncToken) : null;

  do {
    const params = new URLSearchParams({
      showDeleted: "true",
      singleEvents: "true",
      maxResults: "250",
    });
    if (pageToken) {
      params.set("pageToken", pageToken);
    } else if (syncToken) {
      params.set("syncToken", String(syncToken));
    }

    const data = await googleRequest(
      prisma,
      connection,
      "GET",
      `/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`
    );
    if (Array.isArray(data?.items)) items.push(...data.items);
    pageToken = data?.nextPageToken ? String(data.nextPageToken) : null;
    if (!pageToken && data?.nextSyncToken) nextSyncToken = String(data.nextSyncToken);
  } while (pageToken);

  return { items, nextSyncToken };
}

function syncEnabled(settings: CalendarSettings | null) {
  return Boolean(settings?.syncEnabled && settings?.googleSyncEnabled);
}

async function stopGoogleCalendarWatch(prisma: PrismaLike, connection: GoogleConnection) {
  if (!connection.watchChannelId || !connection.watchResourceId) return;
  await googleRequest(prisma, connection, "POST", "/channels/stop", {
    id: connection.watchChannelId,
    resourceId: connection.watchResourceId,
  }).catch(() => null);
}

export async function ensureGoogleCalendarWatch(prisma: PrismaLike, connectionInput: GoogleConnection): Promise<GoogleCalendarWatchResult> {
  const settings = await currentSettings(prisma);
  if (!syncEnabled(settings)) {
    return { ok: true, skipped: true, reason: "Google Calendar sync is disabled" };
  }

  const connection = (await currentConnection(prisma, connectionInput.id)) || connectionInput;
  if (!connection.syncEnabled) {
    return { ok: true, skipped: true, reason: "Selected connection has sync disabled" };
  }

  const calendarId = calendarIdFor(settings, connection);
  if (watchIsFresh(connection) && connection.syncToken) {
    return {
      ok: true,
      skipped: true,
      reason: "Existing watch is still active",
      channelId: connection.watchChannelId || null,
      expiresAt: parseWatchExpiration(connection.watchExpiration)?.toISOString() || null,
    };
  }

  await stopGoogleCalendarWatch(prisma, connection);

  const channelId = `nail-${randomUUID()}`;
  const watch = await googleRequest(
    prisma,
    connection,
    "POST",
    `/calendars/${encodeURIComponent(calendarId)}/events/watch?showDeleted=true&singleEvents=true`,
    {
      id: channelId,
      type: "web_hook",
      address: `${PUBLIC_APP_URL}/api/google-webhook`,
      token: connection.id,
      params: { ttl: String(GOOGLE_WATCH_TTL_SECONDS) },
    }
  );

  const expiration = parseWatchExpiration(watch?.expiration);
  const watchPatch: Record<string, unknown> = {
    watchChannelId: channelId,
    watchResourceId: watch?.resourceId ? String(watch.resourceId) : null,
    watchExpiration: expiration,
  };

  let syncToken = String(connection.syncToken || "").trim() || null;
  if (!syncToken) {
    const initialSync = await listGoogleEvents(prisma, connection, calendarId, null);
    syncToken = initialSync.nextSyncToken || null;
    watchPatch.syncToken = syncToken;
  }

  await (prisma as any).googleCalendarConnection.update({
    where: { id: connection.id },
    data: watchPatch,
  }).catch(() => null);

  await createLog(prisma, {
    direction: "GOOGLE_WEBHOOK",
    status: "WATCH_REGISTERED",
    message: `Watch registered for ${connection.email} calendar ${calendarId} channel=${channelId} expires=${expiration?.toISOString() || "unknown"}`,
    staffId: connection.staffId || null,
  });

  return {
    ok: true,
    channelId,
    expiresAt: expiration?.toISOString() || null,
  };
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

  const calendarId = calendarIdFor(settings, connection);
  const payload = eventPayload(booking, calendarId);

  try {
    const event = booking.googleCalendarEventId
      ? await googleRequest(prisma, connection, "PATCH", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(String(booking.googleCalendarEventId))}`, payload)
      : await googleRequest(prisma, connection, "POST", `/calendars/${encodeURIComponent(calendarId)}/events`, payload);

    const eventId = String(event?.id || booking.googleCalendarEventId || "").trim() || null;
    await persistSyncState(prisma, booking, { eventId, error: null });
    await markConnectionSynced(prisma, connection);
    await ensureGoogleCalendarWatch(prisma, connection).catch(() => null);
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

  const calendarId = calendarIdFor(settings, connection);

  try {
    await googleRequest(prisma, connection, "DELETE", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(String(booking.googleCalendarEventId))}`);
    await persistSyncState(prisma, booking, { eventId: null, error: null });
    await markConnectionSynced(prisma, connection);
    await ensureGoogleCalendarWatch(prisma, connection).catch(() => null);
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

async function resolveBookingForEvent(prisma: PrismaLike, event: GoogleEventLike) {
  const bookingId = String(event.extendedProperties?.private?.nailbookingBookingId || "").trim();
  const eventId = String(event.id || "").trim();

  if (bookingId) {
    const byId = await (prisma as any).booking.findUnique({ where: { id: bookingId }, include: bookingInclude }).catch(() => null);
    if (byId) return byId as BookingLike;
  }

  if (eventId) {
    const byEvent = await (prisma as any).booking.findFirst({
      where: { googleCalendarEventId: eventId, archivedAt: null },
      include: bookingInclude,
    }).catch(() => null);
    if (byEvent) return byEvent as BookingLike;
  }

  return null;
}

async function flagGoogleConflict(prisma: PrismaLike, booking: BookingLike, requestedDay: string, requestedTime: string) {
  const message = `Google Calendar moved booking ${booking.id} to ${requestedDay} at ${requestedTime}, but ${staffText(booking)} is not available. Local booking stayed at ${dayText(booking.date)} ${booking.time}.`;
  await (prisma as any).$transaction(async (tx: any) => {
    await tx.notification.create({
      data: {
        audience: "ADMIN",
        bookingId: booking.id,
        staffId: booking.staffId || booking.requestedStaffId || null,
        type: "GOOGLE_CALENDAR_SYNC_CONFLICT",
        title: "Google Calendar change needs review",
        message,
      },
    });
    await queueOwnerBookingEmail(tx, booking as any, "Google Calendar change needs review", message);
  });
  await deliverPendingCustomerNotifications(prisma as any, booking.id);
  await createLog(prisma, {
    direction: "GOOGLE_INBOUND",
    status: "CONFLICT",
    message,
    bookingId: booking.id,
    staffId: booking.staffId || booking.requestedStaffId || null,
  });
}

async function handleCancelledEvent(prisma: PrismaLike, booking: BookingLike) {
  if (booking.status === "CANCELLED") {
    await (prisma as any).booking.update({
      where: { id: booking.id },
      data: {
        googleCalendarEventId: null,
        googleCalendarSyncedAt: new Date(),
        googleCalendarLastError: null,
        externalProvider: "GOOGLE_CALENDAR",
        externalLastSyncedAt: new Date(),
        externalSyncStatus: "CANCELLED_IN_GOOGLE",
      },
    }).catch(() => null);
    await createLog(prisma, {
      direction: "GOOGLE_INBOUND",
      status: "IGNORED",
      message: `Booking ${booking.id} was already cancelled locally; cleared Google event reference.`,
      bookingId: booking.id,
      staffId: booking.staffId || booking.requestedStaffId || null,
    });
    return { synced: 1, conflicts: 0, ignored: 0 };
  }

  if (["COMPLETED", "NO_SHOW"].includes(String(booking.status || ""))) {
    await createLog(prisma, {
      direction: "GOOGLE_INBOUND",
      status: "IGNORED",
      message: `Ignored Google cancellation for locked booking ${booking.id} with status ${booking.status}.`,
      bookingId: booking.id,
      staffId: booking.staffId || booking.requestedStaffId || null,
    });
    return { synced: 0, conflicts: 0, ignored: 1 };
  }

  const updated = await (prisma as any).$transaction(async (tx: any) => {
    const saved = await updateBookingStatusWithRevenue(tx, booking.id, "CANCELLED", {
      cancellationReason: "Cancelled from Google Calendar",
      googleCalendarEventId: null,
      googleCalendarSyncedAt: new Date(),
      googleCalendarLastError: null,
      externalProvider: "GOOGLE_CALENDAR",
      externalLastSyncedAt: new Date(),
      externalSyncStatus: "CANCELLED_IN_GOOGLE",
      externalPayload: booking,
    });
    await notifyBookingStatusChanged(tx, saved, "Google Calendar");
    await queueOwnerBookingEmail(tx, saved, "Booking cancelled from Google Calendar", `Shop Gmail Calendar cancelled this booking. Local booking is now cancelled.`);
    return saved;
  });

  await deliverPendingCustomerNotifications(prisma as any, updated.id);
  await createLog(prisma, {
    direction: "GOOGLE_INBOUND",
    status: "CANCELLED",
    message: `Local booking ${updated.id} cancelled from Google Calendar update.`,
    bookingId: updated.id,
    staffId: updated.staffId || updated.requestedStaffId || null,
  });
  return { synced: 1, conflicts: 0, ignored: 0 };
}

async function handleRescheduledEvent(prisma: PrismaLike, booking: BookingLike, event: GoogleEventLike) {
  if (!["PENDING", "CONFIRMED"].includes(String(booking.status || ""))) {
    await createLog(prisma, {
      direction: "GOOGLE_INBOUND",
      status: "IGNORED",
      message: `Ignored Google reschedule for locked booking ${booking.id} with status ${booking.status}.`,
      bookingId: booking.id,
      staffId: booking.staffId || booking.requestedStaffId || null,
    });
    return { synced: 0, conflicts: 0, ignored: 1 };
  }

  const slot = parseGoogleEventSlot(event);
  if (!slot) {
    await createLog(prisma, {
      direction: "GOOGLE_INBOUND",
      status: "IGNORED",
      message: `Ignored Google event ${String(event.id || "unknown")} because it does not include a timed start.`,
      bookingId: booking.id,
      staffId: booking.staffId || booking.requestedStaffId || null,
    });
    return { synced: 0, conflicts: 0, ignored: 1 };
  }

  const sameSlot = slot.day === dayText(booking.date) && slot.time === String(booking.time || "");
  if (sameSlot) {
    if (event.id && event.id !== booking.googleCalendarEventId) {
      await (prisma as any).booking.update({
        where: { id: booking.id },
        data: {
          googleCalendarEventId: event.id,
          googleCalendarSyncedAt: new Date(),
          googleCalendarLastError: null,
          externalProvider: "GOOGLE_CALENDAR",
          externalLastSyncedAt: new Date(),
          externalSyncStatus: "SYNCED",
          externalPayload: event as any,
        },
      }).catch(() => null);
    }
    await createLog(prisma, {
      direction: "GOOGLE_INBOUND",
      status: "IGNORED",
      message: `Google Calendar change for booking ${booking.id} did not move the time slot.`,
      bookingId: booking.id,
      staffId: booking.staffId || booking.requestedStaffId || null,
    });
    return { synced: 0, conflicts: 0, ignored: 1 };
  }

  const assignedStaffId = booking.staffId || booking.requestedStaffId || null;
  if (assignedStaffId) {
    const free = await isStaffAvailableAndFree(prisma as any, assignedStaffId, slot.day, slot.time, totalDurationMinutes(booking), booking.id);
    if (!free) {
      await flagGoogleConflict(prisma, booking, slot.day, slot.time);
      return { synced: 0, conflicts: 1, ignored: 0 };
    }
  }

  const updated = await (prisma as any).$transaction(async (tx: any) => {
    const saved = await tx.booking.update({
      where: { id: booking.id },
      data: {
        date: new Date(`${slot.day}T00:00:00.000Z`),
        time: slot.time,
        googleCalendarEventId: event.id ? String(event.id) : booking.googleCalendarEventId || null,
        googleCalendarSyncedAt: new Date(),
        googleCalendarLastError: null,
        externalProvider: "GOOGLE_CALENDAR",
        externalLastSyncedAt: new Date(),
        externalSyncStatus: "RESCHEDULED_IN_GOOGLE",
        externalPayload: event as any,
      },
      include: bookingInclude,
    });

    const notificationMessage = `${saved.customerName}'s booking was moved from Google Calendar to ${slot.day} at ${slot.time}.`;
    await tx.notification.create({
      data: {
        audience: "ADMIN",
        bookingId: saved.id,
        staffId: saved.staffId || saved.requestedStaffId || null,
        type: "GOOGLE_CALENDAR_RESCHEDULED_BOOKING",
        title: "Booking rescheduled from Google Calendar",
        message: notificationMessage,
      },
    });

    await queueOwnerBookingEmail(tx, saved, "Booking rescheduled from Google Calendar", notificationMessage);
    if (assignedStaffId) {
      await queueStaffBookingEmail(tx, saved, "Booking rescheduled", `Shop Gmail Calendar moved this booking to ${slot.day} at ${slot.time}. Check Staff Portal for the updated slot.`, [assignedStaffId]);
    }
    await queueCustomerWebsiteNotification(
      tx,
      saved,
      "Booking rescheduled",
      `Your booking has been moved to ${slot.day} at ${slot.time} by the shop calendar. Please contact the shop if the new time does not work for you.`,
      "CUSTOMER_BOOKING_RESCHEDULED"
    );
    await queueCustomerBookingNotification(tx, saved, "booking_rescheduled");
    return saved;
  });

  await deliverPendingCustomerNotifications(prisma as any, updated.id);
  await createLog(prisma, {
    direction: "GOOGLE_INBOUND",
    status: "RESCHEDULED",
    message: `Local booking ${updated.id} rescheduled from Google Calendar to ${slot.day} at ${slot.time}.`,
    bookingId: updated.id,
    staffId: updated.staffId || updated.requestedStaffId || null,
  });
  return { synced: 1, conflicts: 0, ignored: 0 };
}

async function applyGoogleEventChange(prisma: PrismaLike, event: GoogleEventLike) {
  const booking = await resolveBookingForEvent(prisma, event);
  if (!booking) return { synced: 0, conflicts: 0, ignored: 1 };

  if (String(event.status || "").toLowerCase() === "cancelled") {
    return handleCancelledEvent(prisma, booking);
  }

  return handleRescheduledEvent(prisma, booking, event);
}

export async function reconcileGoogleCalendarWebhook(prisma: PrismaLike, connectionInput: GoogleConnection): Promise<GoogleCalendarWebhookResult> {
  const settings = await currentSettings(prisma);
  if (!syncEnabled(settings)) {
    return { ok: true, skipped: true, reason: "Google Calendar sync is disabled" };
  }

  const connection = (await currentConnection(prisma, connectionInput.id)) || connectionInput;
  if (!connection.syncEnabled) {
    return { ok: true, skipped: true, reason: "Connection sync is disabled" };
  }

  const calendarId = calendarIdFor(settings, connection);
  let changes: { items: GoogleEventLike[]; nextSyncToken: string | null };
  let usedFullResync = false;

  try {
    changes = await listGoogleEvents(prisma, connection, calendarId, connection.syncToken || null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/410|sync token/i.test(message)) {
      usedFullResync = true;
      changes = await listGoogleEvents(prisma, connection, calendarId, null);
      await createLog(prisma, {
        direction: "GOOGLE_WEBHOOK",
        status: "FULL_RESYNC",
        message: `Google sync token expired for ${connection.email}; performed full resync.`,
        staffId: connection.staffId || null,
      });
    } else {
      await createLog(prisma, {
        direction: "GOOGLE_WEBHOOK",
        status: "FAILED",
        message,
        staffId: connection.staffId || null,
      });
      return { ok: false, error: message };
    }
  }

  let synced = 0;
  let conflicts = 0;
  let ignored = 0;
  for (const event of changes.items) {
    const result = await applyGoogleEventChange(prisma, event);
    synced += result.synced;
    conflicts += result.conflicts;
    ignored += result.ignored;
  }

  await (prisma as any).googleCalendarConnection.update({
    where: { id: connection.id },
    data: {
      syncToken: changes.nextSyncToken || connection.syncToken || null,
      lastWebhookAt: new Date(),
      lastSyncAt: new Date(),
    },
  }).catch(() => null);
  await (prisma as any).calendarSyncSetting.update({ where: { id: "default" }, data: { lastSyncAt: new Date() } }).catch(() => null);

  await createLog(prisma, {
    direction: "GOOGLE_WEBHOOK",
    status: usedFullResync ? "FULL_RESYNC_DONE" : "RECONCILED",
    message: `Webhook reconciled ${changes.items.length} event(s) for ${connection.email}. synced=${synced} conflicts=${conflicts} ignored=${ignored}`,
    staffId: connection.staffId || null,
  });

  return {
    ok: true,
    processed: changes.items.length,
    synced,
    conflicts,
    ignored,
  };
}
