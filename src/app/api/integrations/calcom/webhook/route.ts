import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";
import { bookingInclude, serializeBooking, updateBookingStatusWithRevenue } from "@/lib/booking-workflow";
import { notifyBookingStatusChanged } from "@/lib/notifications";
import { deliverPendingCustomerNotifications } from "@/lib/customer-notifications";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function safeCompare(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function verifySignature(raw: string, supplied: string | null) {
  const secret = String(process.env.CALCOM_WEBHOOK_SECRET || "").trim();
  if (!secret) return true;
  if (!supplied) return false;
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const normalized = supplied.replace(/^sha256=/i, "").trim();
  return safeCompare(normalized, expected) || safeCompare(`sha256=${normalized}`, `sha256=${expected}`);
}

function eventName(payload: any) {
  return String(payload?.triggerEvent || payload?.event || payload?.type || "CALCOM_WEBHOOK").toUpperCase();
}

function bookingUid(payload: any) {
  return String(payload?.payload?.uid || payload?.uid || payload?.booking?.uid || payload?.payload?.bookingUid || "").trim();
}

function localBookingId(payload: any) {
  return String(payload?.payload?.metadata?.localBookingId || payload?.metadata?.localBookingId || payload?.booking?.metadata?.localBookingId || "").trim();
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const signature = req.headers.get("x-cal-signature-256") || req.headers.get("x-cal-signature") || req.headers.get("cal-signature");
  if (!verifySignature(raw, signature)) {
    return NextResponse.json({ error: "Invalid Cal.com webhook signature" }, { status: 401 });
  }

  const body = JSON.parse(raw || "{}");
  const trigger = eventName(body);
  const uid = bookingUid(body);
  const localId = localBookingId(body);
  let booking: any = null;

  if (localId) {
    booking = await prisma.booking.findUnique({ where: { id: localId }, include: bookingInclude });
  }
  if (!booking && uid) {
    booking = await prisma.booking.findFirst({ where: { externalBookingUid: uid } as any, include: bookingInclude });
  }

  await (prisma as any).calendarSyncLog.create({
    data: {
      direction: "INBOUND",
      status: "RECEIVED",
      message: `${trigger}${uid ? ` uid=${uid}` : ""}${localId ? ` local=${localId}` : ""}`.slice(0, 500),
      bookingId: booking?.id || localId || null,
      staffId: booking?.staffId || booking?.requestedStaffId || null,
    },
  }).catch(() => null);

  if (booking) {
    if (uid && !booking.externalBookingUid) {
      booking = await prisma.booking.update({ where: { id: booking.id }, data: { externalProvider: "CALCOM", externalBookingUid: uid, externalLastSyncedAt: new Date(), externalSyncStatus: "WEBHOOK_LINKED", externalPayload: body } as any, include: bookingInclude });
    }

    if (trigger.includes("CANCEL")) {
      const updated = await prisma.$transaction(async (tx) => {
        const row = await updateBookingStatusWithRevenue(tx, booking.id, "CANCELLED", { cancellationReason: "Cancelled from Cal.com", externalSyncStatus: "CANCELLED_IN_CALCOM", externalLastSyncedAt: new Date(), externalPayload: body } as any);
        await notifyBookingStatusChanged(tx, row, "Cal.com");
        return row;
      });
      await deliverPendingCustomerNotifications(prisma, updated.id);
      return NextResponse.json({ ok: true, action: "cancelled_local_booking", booking: serializeBooking(updated) });
    }

    await prisma.booking.update({ where: { id: booking.id }, data: { externalProvider: "CALCOM", externalLastSyncedAt: new Date(), externalSyncStatus: trigger, externalPayload: body } as any }).catch(() => null);
  } else {
    await prisma.notification.create({
      data: {
        audience: "ADMIN",
        type: "CALCOM_EXTERNAL_BOOKING_EVENT",
        title: "Cal.com booking event needs review",
        message: `Cal.com sent ${trigger}${uid ? ` for uid ${uid}` : ""}, but it did not map to a NailBooking record. Check Cal.com and Admin Calendar before accepting new appointments.`,
      },
    }).catch(() => null);
  }

  return NextResponse.json({ ok: true, trigger, uid, localBookingId: localId || null, mapped: Boolean(booking) });
}

export async function GET() {
  return NextResponse.json({ ok: true, service: "calcom-webhook", configured: Boolean(process.env.CALCOM_WEBHOOK_SECRET) });
}
