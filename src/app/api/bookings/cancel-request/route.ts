import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser } from "@/lib/auth";
import { bookingInclude, serializeBooking, updateBookingStatusWithRevenue } from "@/lib/booking-workflow";
import { notifyBookingStatusChanged } from "@/lib/notifications";
import { deliverPendingCustomerNotifications } from "@/lib/customer-notifications";
import { bookingReference } from "@/lib/payment-locks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function appendNote(existing: string | null | undefined, line: string) {
  const current = String(existing || "").trim();
  return [current, line].filter(Boolean).join("\n").slice(0, 4000);
}

export async function POST(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser) return NextResponse.json({ error: "Please sign in first" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const id = String(body.id || "").trim();
  const reason = String(body.reason || "").trim().replace(/\s+/g, " ").slice(0, 300);
  if (!id) return NextResponse.json({ error: "Booking id is required" }, { status: 400 });
  if (!reason) return NextResponse.json({ error: "Please enter a cancellation reason" }, { status: 400 });

  const booking = await prisma.booking.findFirst({
    where: { id, userId: authUser.id, archivedAt: null },
    include: bookingInclude,
  });
  if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  if (["CANCELLED", "COMPLETED", "NO_SHOW"].includes(booking.status)) {
    return NextResponse.json({ error: "This booking can no longer receive a cancellation request" }, { status: 409 });
  }

  const now = new Date();
  const reference = booking.paymentReference || bookingReference(booking.id);
  const noteLine = `[Customer cancellation request ${now.toISOString()}] Ref ${reference}. Reason: ${reason}`;

  const shouldAutoCancel = booking.status === "PENDING";

  const updated = await prisma.$transaction(async (tx) => {
    if (shouldAutoCancel) {
      const saved = await updateBookingStatusWithRevenue(tx, booking.id, "CANCELLED", {
        cancellationReason: `Customer cancelled before confirmation: ${reason}`,
        notes: appendNote(booking.notes, noteLine),
      });
      await notifyBookingStatusChanged(tx, saved, booking.customerName);
      await tx.notification.create({
        data: {
          audience: "ADMIN",
          bookingId: booking.id,
          type: "CUSTOMER_CANCELLED_PENDING_BOOKING",
          title: "Pending booking cancelled by customer",
          message: `${booking.customerName} cancelled pending booking ${reference}. The slot is now released. Reason: ${reason}.`,
        },
      });
      return saved;
    }

    const saved = await tx.booking.update({
      where: { id: booking.id },
      data: {
        cancellationReason: `Customer requested cancellation: ${reason}`,
        notes: appendNote(booking.notes, noteLine),
      },
      include: bookingInclude,
    });
    const notifications: any[] = [
      {
        audience: "ADMIN",
        staffId: booking.staffId || booking.requestedStaffId || null,
        bookingId: booking.id,
        type: "CUSTOMER_CANCEL_REQUEST",
        title: "Customer requested cancellation",
        message: `${booking.customerName} requested cancellation for ${reference}. Reason: ${reason}. Review in Admin Bookings before cancelling/refunding.`,
      },
    ];
    const staffTargets = Array.from(new Set([booking.staffId, booking.requestedStaffId].filter(Boolean).map(String)));
    for (const staffId of staffTargets) {
      notifications.push({
        audience: "STAFF",
        staffId,
        bookingId: booking.id,
        type: "STAFF_CUSTOMER_CANCEL_REQUEST",
        title: "Customer requested cancellation",
        message: `${booking.customerName} requested cancellation for ${reference}. The booking is still confirmed until admin reviews it. Reason: ${reason}.`,
      });
    }
    await tx.notification.createMany({ data: notifications });
    return saved;
  });

  if (shouldAutoCancel) await deliverPendingCustomerNotifications(prisma, updated.id);

  return NextResponse.json({
    booking: serializeBooking(updated),
    requested: !shouldAutoCancel,
    cancelled: shouldAutoCancel,
    message: shouldAutoCancel ? "Pending booking cancelled and slot released." : "Cancellation request sent to admin.",
  });
}
