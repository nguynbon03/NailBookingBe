import { PrismaClient } from "@prisma/client";
import { bookingInclude } from "@/lib/booking-workflow";

type PrismaLike = PrismaClient;

type BookingLike = {
  id: string;
  date: Date;
  time: string;
  status: string;
  customerName: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
  totalPrice?: unknown;
  externalBookingUid?: string | null;
  externalPayload?: unknown;
  cancellationReason?: string | null;
  services?: { service?: { name?: string | null; duration?: number | null } | null }[];
  staff?: { name?: string | null; email?: string | null } | null;
  requestedStaff?: { name?: string | null; email?: string | null } | null;
};

const DEFAULT_BASE = "https://api.cal.com/v2";
const DEFAULT_VERSION = "2024-08-13";

function env(name: string) {
  return String(process.env[name] || "").trim();
}

export function calcomConfigured() {
  return Boolean(env("CALCOM_API_KEY") && (env("CALCOM_EVENT_TYPE_ID") || (env("CALCOM_EVENT_TYPE_SLUG") && env("CALCOM_USERNAME"))));
}

function baseUrl() {
  return (env("CALCOM_API_BASE_URL") || DEFAULT_BASE).replace(/\/$/, "");
}

function apiVersion() {
  return env("CALCOM_BOOKING_API_VERSION") || DEFAULT_VERSION;
}

function timezone() {
  return env("CALCOM_TIMEZONE") || "Europe/London";
}

async function calcomFetch(path: string, init: RequestInit = {}) {
  const key = env("CALCOM_API_KEY");
  if (!key) throw new Error("CALCOM_API_KEY is not configured");
  const headers: Record<string, string> = {
    Authorization: String.fromCharCode(66, 101, 97, 114, 101, 114) + " " + key,
    "Content-Type": "application/json",
    "cal-api-version": apiVersion(),
    ...((init.headers as Record<string, string>) || {}),
  };
  const res = await fetch(`${baseUrl()}${path.startsWith("/") ? path : `/${path}`}`, { ...init, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `Cal.com HTTP ${res.status}`);
  return data;
}

function toNumberOrString(value: string) {
  return /^\d+$/.test(value) ? Number(value) : value;
}

function serviceNames(booking: BookingLike) {
  return (booking.services || []).map((item) => item.service?.name).filter(Boolean).join(", ") || "Nail appointment";
}

function durationMinutes(booking: BookingLike) {
  const duration = (booking.services || []).reduce((sum, item) => sum + Number(item.service?.duration || 0), 0);
  return Math.max(15, duration || Number(env("CALCOM_DEFAULT_DURATION_MINUTES") || 60));
}

function zonedTimeToUtc(date: Date, time: string, timeZone: string) {
  const [hour, minute] = String(time || "00:00").split(":").map((n) => Number(n || 0));
  const utcGuess = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour || 0, minute || 0, 0);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcGuess)).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  const offset = asUtc - utcGuess;
  return new Date(utcGuess - offset);
}

function eventTypePayload() {
  const eventTypeId = env("CALCOM_EVENT_TYPE_ID");
  if (eventTypeId) return { eventTypeId: toNumberOrString(eventTypeId), eventTypeIdText: eventTypeId };
  return { eventTypeSlug: env("CALCOM_EVENT_TYPE_SLUG"), username: env("CALCOM_USERNAME"), eventTypeIdText: env("CALCOM_EVENT_TYPE_SLUG") };
}

export async function syncBookingToCalCom(prisma: PrismaLike, bookingInput: BookingLike) {
  if (!calcomConfigured()) return { skipped: true, reason: "CALCOM_API_KEY / event type not configured" };
  if (!bookingInput.customerEmail) return { skipped: true, reason: "booking has no customer email" };

  const booking = await prisma.booking.findUnique({ where: { id: bookingInput.id }, include: bookingInclude }) as any;
  if (!booking) return { skipped: true, reason: "booking not found" };

  if (!["CONFIRMED", "COMPLETED"].includes(booking.status)) {
    if (booking.externalBookingUid && booking.status === "CANCELLED") return cancelCalComBooking(prisma, booking);
    return { skipped: true, reason: `status ${booking.status} is not synced to Cal.com` };
  }

  if (booking.externalBookingUid) return { skipped: true, reason: "already synced", uid: booking.externalBookingUid };

  const tz = timezone();
  const event = eventTypePayload();
  const start = zonedTimeToUtc(booking.date, booking.time, tz).toISOString();
  const body: Record<string, unknown> = {
    start,
    attendee: {
      name: booking.customerName,
      email: booking.customerEmail,
      timeZone: tz,
      phoneNumber: booking.customerPhone || undefined,
    },
    lengthInMinutes: durationMinutes(booking),
    metadata: {
      source: "nailbooking",
      localBookingId: booking.id,
      staffName: booking.staff?.name || booking.requestedStaff?.name || "Any Staff",
      services: serviceNames(booking),
    },
  };
  if ("eventTypeId" in event) body.eventTypeId = event.eventTypeId;
  else {
    body.eventTypeSlug = event.eventTypeSlug;
    body.username = event.username;
  }

  try {
    const data = await calcomFetch("/bookings", { method: "POST", body: JSON.stringify(body) });
    const uid = data?.data?.uid || data?.uid || data?.booking?.uid || null;
    await prisma.booking.update({
      where: { id: booking.id },
      data: {
        externalProvider: "CALCOM",
        externalBookingUid: uid ? String(uid) : null,
        externalEventTypeId: event.eventTypeIdText,
        externalLastSyncedAt: new Date(),
        externalSyncStatus: uid ? "SYNCED" : "SYNCED_NO_UID",
        externalPayload: data,
      } as any,
    });
    await (prisma as any).calendarSyncLog.create({ data: { direction: "OUTBOUND", status: "SYNCED", message: `Cal.com booking synced${uid ? ` uid=${uid}` : ""}`, bookingId: booking.id, staffId: booking.staffId || booking.requestedStaffId || null } }).catch(() => null);
    return { ok: true, uid, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cal.com sync failed";
    await prisma.booking.update({
      where: { id: booking.id },
      data: { externalProvider: "CALCOM", externalLastSyncedAt: new Date(), externalSyncStatus: "FAILED", googleCalendarLastError: message } as any,
    }).catch(() => null);
    await (prisma as any).calendarSyncLog.create({ data: { direction: "OUTBOUND", status: "FAILED", message: message.slice(0, 500), bookingId: booking.id, staffId: booking.staffId || booking.requestedStaffId || null } }).catch(() => null);
    return { ok: false, error: message };
  }
}

export async function cancelCalComBooking(prisma: PrismaLike, booking: BookingLike) {
  if (!calcomConfigured() || !booking.externalBookingUid) return { skipped: true };
  try {
    const data = await calcomFetch(`/bookings/${encodeURIComponent(booking.externalBookingUid)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ cancellationReason: booking.cancellationReason || "Cancelled in NailBooking" }),
    });
    await prisma.booking.update({ where: { id: booking.id }, data: { externalLastSyncedAt: new Date(), externalSyncStatus: "CANCELLED", externalPayload: data } as any });
    await (prisma as any).calendarSyncLog.create({ data: { direction: "OUTBOUND", status: "CANCELLED", message: `Cal.com booking cancelled uid=${booking.externalBookingUid}`, bookingId: booking.id } }).catch(() => null);
    return { ok: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cal.com cancel failed";
    await prisma.booking.update({ where: { id: booking.id }, data: { externalLastSyncedAt: new Date(), externalSyncStatus: "CANCEL_FAILED", googleCalendarLastError: message } as any }).catch(() => null);
    return { ok: false, error: message };
  }
}
