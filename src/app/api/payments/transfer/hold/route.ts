import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { availableStaffIdsAt, isStaffAvailableAndFree } from "@/lib/availability";
import { bookingInclude, serializeBooking, updateBookingStatusWithRevenue } from "@/lib/booking-workflow";
import { hashVerificationToken } from "@/lib/email-verification";
import { bookingReference, publicBankTransferDetails, releaseStaffSlotRedisLock } from "@/lib/payment-locks";
import { notifyBookingStatusChanged } from "@/lib/notifications";
import { deliverPendingCustomerNotifications } from "@/lib/customer-notifications";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function durationFromBooking(booking: any) {
  const total = (booking.services || []).reduce((sum: number, item: any) => sum + Number(item.service?.duration || 0), 0);
  return total || 30;
}

function appendNote(existing: string | null | undefined, line: string) {
  const current = String(existing || "").trim();
  return [current, line].filter(Boolean).join("\n").slice(0, 4000);
}

async function chooseStaffForPaidBooking(booking: any) {
  const duration = durationFromBooking(booking);
  const preferred = booking.requestedStaffId || booking.staffId || booking.paymentHoldStaffId || null;
  const candidates: string[] = [];

  if (preferred) {
    const ok = await isStaffAvailableAndFree(prisma, preferred, booking.date, booking.time, duration, booking.id);
    if (ok) candidates.push(preferred);
  }

  const fallback = await availableStaffIdsAt(prisma, booking.date, booking.time, duration);
  for (const id of fallback) {
    if (!candidates.includes(id)) candidates.push(id);
  }

  return candidates[0] || null;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const token = String(body.token || "").trim();
  if (!token) return NextResponse.json({ error: "Transfer token is required" }, { status: 400 });

  const tokenHash = hashVerificationToken(token);
  const booking = await prisma.booking.findFirst({
    where: { paymentTransferTokenHash: tokenHash },
    include: bookingInclude,
  });

  if (!booking) return NextResponse.json({ error: "Transfer link is invalid" }, { status: 404 });
  if (booking.archivedAt || booking.status === "CANCELLED") {
    return NextResponse.json({ error: "This booking is not payable" }, { status: 409 });
  }
  if (!booking.emailVerifiedAt) {
    return NextResponse.json({ error: "Account email must be verified before payment" }, { status: 403 });
  }

  const reference = booking.paymentReference || bookingReference(booking.id);
  const now = new Date();

  if (booking.status !== "PENDING") {
    return NextResponse.json({
      booking: serializeBooking(booking),
      paid: Boolean(booking.paymentConfirmedAt),
      confirmed: booking.status === "CONFIRMED",
      alreadyHandled: true,
      reference,
      bank: publicBankTransferDetails(),
      message: booking.status === "CONFIRMED"
        ? "Payment already recorded and booking is confirmed."
        : "Payment already recorded. The shop will manage the booking.",
    });
  }

  const staffId = await chooseStaffForPaidBooking(booking);
  const openedNote = `[Secure transfer opened ${now.toISOString()}] Ref ${reference}. Customer click is treated as payment received per shop rule.`;

  if (staffId) {
    const confirmed = await prisma.$transaction(async (tx) => {
      const updated = await updateBookingStatusWithRevenue(tx, booking.id, "CONFIRMED", {
        staffId,
        paymentHoldStaffId: null,
        paymentHoldStartedAt: null,
        paymentHoldExpiresAt: null,
        paymentTransferOpenedAt: booking.paymentTransferOpenedAt || now,
        paymentConfirmedAt: booking.paymentConfirmedAt || now,
        paymentConfirmedBy: "Customer secure-transfer click",
        paymentReference: reference,
        notes: appendNote(booking.notes, `${openedNote} Staff assigned automatically.`),
      });
      await notifyBookingStatusChanged(tx, updated, "Secure transfer");
      await tx.notification.create({
        data: {
          audience: "ADMIN",
          bookingId: booking.id,
          staffId,
          type: "PAYMENT_AUTO_CONFIRMED",
          title: "Secure transfer auto-confirmed booking",
          message: `${booking.customerName} clicked secure transfer for ${reference}. Payment is treated as received and booking was confirmed with an available staff member.`,
        },
      });
      return updated;
    });

    if (booking.paymentHoldStaffId) await releaseStaffSlotRedisLock(booking.id, booking.paymentHoldStaffId, booking.date, booking.time);
    await deliverPendingCustomerNotifications(prisma, confirmed.id);

    return NextResponse.json({
      booking: serializeBooking(confirmed),
      paid: true,
      confirmed: true,
      needsAdminResolution: false,
      reference,
      bank: publicBankTransferDetails(),
      message: "Payment recorded. Your booking is confirmed.",
    });
  }

  const pending = await prisma.$transaction(async (tx) => {
    const updated = await tx.booking.update({
      where: { id: booking.id },
      data: {
        staffId: null,
        paymentHoldStaffId: null,
        paymentHoldStartedAt: null,
        paymentHoldExpiresAt: null,
        paymentTransferOpenedAt: booking.paymentTransferOpenedAt || now,
        paymentConfirmedAt: booking.paymentConfirmedAt || now,
        paymentConfirmedBy: "Customer secure-transfer click",
        paymentReference: reference,
        notes: appendNote(booking.notes, `${openedNote} No staff was free at click time; admin must refund, change time, or find replacement staff.`),
      },
      include: bookingInclude,
    });
    await tx.notification.create({
      data: {
        audience: "ADMIN",
        bookingId: booking.id,
        type: "PAYMENT_NEEDS_ADMIN_RESOLUTION",
        title: "Paid booking needs admin resolution",
        message: `${booking.customerName} clicked secure transfer for ${reference}, but no staff was free for ${booking.date.toISOString().slice(0, 10)} at ${booking.time}. Admin must refund, move the appointment, or find replacement staff.`,
      },
    });
    return updated;
  });

  if (booking.paymentHoldStaffId) await releaseStaffSlotRedisLock(booking.id, booking.paymentHoldStaffId, booking.date, booking.time);

  return NextResponse.json({
    booking: serializeBooking(pending),
    paid: true,
    confirmed: false,
    needsAdminResolution: true,
    reference,
    bank: publicBankTransferDetails(),
    message: "Payment recorded. The shop will contact you to confirm the time/staff, move the appointment, or arrange a refund if needed.",
  });
}
