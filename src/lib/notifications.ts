import { PrismaClient } from "@prisma/client";
import { queueCustomerBookingNotification } from "@/lib/customer-notifications";

type PrismaTx = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export async function notifyBookingCreated(tx: PrismaTx, booking: any, paymentTransferUrl?: string, depositReasons: string[] = []) {
  const day = booking.date.toISOString().slice(0, 10);
  const depositRequired = Boolean(booking.depositRequired || paymentTransferUrl);
  const reasonText = depositReasons.length ? ` Reason: ${depositReasons.join(", ")}.` : "";
  const data: any[] = [
    {
      audience: "ADMIN",
      bookingId: booking.id,
      type: depositRequired ? "BOOKING_DEPOSIT_REQUIRED" : "BOOKING_REQUEST_CREATED",
      title: depositRequired ? "New booking needs deposit" : "New booking request",
      message: depositRequired
        ? `${booking.customerName} requested ${day} at ${booking.time}. Anti-spam protection requires a deposit before staff assignment.${reasonText}`
        : `${booking.customerName} requested ${day} at ${booking.time}. Staff can accept this booking from Staff Portal.`,
    },
  ];

  if (!depositRequired) {
    data.push({
      audience: "STAFF",
      bookingId: booking.id,
      type: "BOOKING_AVAILABLE_FOR_STAFF",
      title: "New booking waiting for staff",
      message: `${booking.customerName} requested ${day} at ${booking.time}. Open Staff Portal and accept if you can take this job.`,
    });
  }

  await tx.notification.createMany({ data });
  await queueCustomerBookingNotification(tx, { ...booking, paymentTransferUrl }, depositRequired ? "payment_transfer_link" : "booking_created");
}

export async function notifyBookingStatusChanged(
  tx: PrismaTx,
  booking: any,
  actorName: string
) {
  const staffName = booking.staff?.name || booking.requestedStaff?.name || actorName;
  const base = `${booking.customerName}: ${booking.status}${staffName ? ` by ${staffName}` : ""}.`;
  const data = [
    {
      audience: "ADMIN",
      staffId: booking.staffId || null,
      bookingId: booking.id,
      type: "BOOKING_STATUS_CHANGED",
      title: `Booking ${booking.status.toLowerCase()}`,
      message: base,
    },
  ];

  if (booking.status === "CONFIRMED" && !booking.staffId) {
    data.push({
      audience: "STAFF",
      staffId: null,
      bookingId: booking.id,
      type: "BOOKING_AVAILABLE_FOR_STAFF",
      title: "Booking ready for staff",
      message: `${booking.customerName}'s booking for ${booking.date.toISOString().slice(0, 10)} at ${booking.time} is ready. Open Staff Portal and accept the job if you can take it.`,
    });
  }

  if (booking.staffId) {
    data.push({
      audience: "STAFF",
      staffId: booking.staffId,
      bookingId: booking.id,
      type: "STAFF_BOOKING_UPDATED",
      title: `Booking ${booking.status.toLowerCase()}`,
      message: base,
    });
  }

  await tx.notification.createMany({ data });

  if (booking.status === "CONFIRMED") {
    await queueCustomerBookingNotification(tx, booking, "booking_confirmed");
  } else if (booking.status === "CANCELLED") {
    await queueCustomerBookingNotification(tx, booking, "booking_cancelled");
  } else if (booking.status === "NO_SHOW") {
    await queueCustomerBookingNotification(tx, booking, "booking_no_show");
  }
}
