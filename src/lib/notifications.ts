import { PrismaClient } from "@prisma/client";
import { queueCustomerBookingNotification } from "@/lib/customer-notifications";

type PrismaTx = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export async function notifyBookingCreated(tx: PrismaTx, booking: any, emailVerificationUrl?: string) {
  await tx.notification.create({
    data: {
      audience: "ADMIN",
      bookingId: booking.id,
      type: "BOOKING_AWAITING_EMAIL_VERIFICATION",
      title: "Booking awaiting email verification",
      message: `${booking.customerName} requested ${booking.date.toISOString().slice(0, 10)} at ${booking.time}. Wait until the customer clicks the email verification link before confirming or assigning staff.`,
    },
  });
  await queueCustomerBookingNotification(tx, { ...booking, emailVerificationUrl }, "booking_created");
}

export async function notifyBookingStatusChanged(
  tx: PrismaTx,
  booking: any,
  actorName: string
) {
  const staffName = booking.staff?.name || actorName;
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
      type: "PAID_JOB_AVAILABLE",
      title: "New paid job available",
      message: `${booking.customerName} paid for ${booking.date.toISOString().slice(0, 10)} at ${booking.time}. Open Staff Portal and accept the job if you can take it.`,
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
