import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { availableStaffIdsAt, isStaffAvailableAndFree } from "@/lib/availability";
import { bookingInclude, serializeBooking } from "@/lib/booking-workflow";
import { hashVerificationToken } from "@/lib/email-verification";
import { bookingReference, isStaffSlotLocked, PAYMENT_HOLD_TTL_SECONDS, publicBankTransferDetails, refreshStaffSlotRedisLock, releaseStaffSlotRedisLock, setStaffSlotRedisLock } from "@/lib/payment-locks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function durationFromBooking(booking: any) {
  const total = (booking.services || []).reduce((sum: number, item: any) => sum + Number(item.service?.duration || 0), 0);
  return total || 30;
}

function holdExpiresAt() {
  return new Date(Date.now() + PAYMENT_HOLD_TTL_SECONDS * 1000);
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
  if (booking.status !== "PENDING") {
    return NextResponse.json({ booking: serializeBooking(booking), alreadyConfirmed: booking.status === "CONFIRMED", bank: publicBankTransferDetails() });
  }
  if (!booking.emailVerifiedAt) {
    return NextResponse.json({ error: "Account email must be verified before payment" }, { status: 403 });
  }

  const now = new Date();
  if (!booking.paymentTransferExpiresAt || booking.paymentTransferExpiresAt < now) {
    return NextResponse.json({ error: "This transfer link expired. Please create a new booking request so we do not lock staff unfairly." }, { status: 410 });
  }

  const existingHoldValid = booking.paymentHoldStaffId && booking.paymentHoldExpiresAt && booking.paymentHoldExpiresAt > now;
  if (existingHoldValid) {
    await refreshStaffSlotRedisLock(booking.id, booking.paymentHoldStaffId!, booking.date, booking.time);
    return NextResponse.json({
      booking: serializeBooking(booking),
      locked: true,
      staffId: booking.paymentHoldStaffId,
      expiresAt: booking.paymentHoldExpiresAt,
      reference: booking.paymentReference || bookingReference(booking.id),
      bank: publicBankTransferDetails(),
    });
  }

  const duration = durationFromBooking(booking);
  let candidates: string[] = [];
  const requestedStaffId = booking.requestedStaffId || booking.staffId || null;
  if (requestedStaffId) {
    const ok = await isStaffAvailableAndFree(prisma, requestedStaffId, booking.date, booking.time, duration);
    const locked = await isStaffSlotLocked(prisma, requestedStaffId, booking.date, booking.time, booking.id);
    if (ok && !locked) candidates = [requestedStaffId];
  } else {
    candidates = await availableStaffIdsAt(prisma, booking.date, booking.time, duration);
  }

  for (const staffId of candidates) {
    const redisLocked = await setStaffSlotRedisLock(booking.id, staffId, booking.date, booking.time);
    if (!redisLocked) continue;

    try {
      const expiresAt = holdExpiresAt();
      const updated = await prisma.$transaction(async (tx) => {
        const locked = await isStaffSlotLocked(tx, staffId, booking.date, booking.time, booking.id);
        if (locked) throw new Error("slot_locked");
        return tx.booking.update({
          where: { id: booking.id },
          data: {
            staffId,
            paymentHoldStaffId: staffId,
            paymentHoldStartedAt: now,
            paymentHoldExpiresAt: expiresAt,
            paymentTransferOpenedAt: booking.paymentTransferOpenedAt || now,
            paymentReference: booking.paymentReference || bookingReference(booking.id),
          },
          include: bookingInclude,
        });
      });
      return NextResponse.json({
        booking: serializeBooking(updated),
        locked: true,
        staffId,
        expiresAt: updated.paymentHoldExpiresAt,
        reference: updated.paymentReference || bookingReference(updated.id),
        bank: publicBankTransferDetails(),
      });
    } catch (error) {
      await releaseStaffSlotRedisLock(booking.id, staffId, booking.date, booking.time);
      if (!(error instanceof Error) || error.message !== "slot_locked") throw error;
    }
  }

  return NextResponse.json({ error: "No staff is still free for this time. Please choose another time before transferring." }, { status: 409 });
}
