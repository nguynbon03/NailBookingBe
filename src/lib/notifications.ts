import { PrismaClient } from "@prisma/client";

type PrismaTx = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export async function notifyBookingCreated(tx: PrismaTx, booking: { id: string; customerName: string; date: Date; time: string; totalPrice: unknown }) {
  await tx.notification.createMany({
    data: [
      {
        audience: "ADMIN",
        bookingId: booking.id,
        type: "BOOKING_CREATED",
        title: "New booking waiting for staff",
        message: `${booking.customerName} booked ${booking.date.toISOString().slice(0, 10)} at ${booking.time}. Pending staff confirmation.`,
      },
      {
        audience: "STAFF",
        bookingId: booking.id,
        type: "STAFF_JOB_AVAILABLE",
        title: "New job available",
        message: `${booking.customerName} booked ${booking.date.toISOString().slice(0, 10)} at ${booking.time}. Open the staff portal to claim it.`,
      },
    ],
  });
}

export async function notifyBookingStatusChanged(
  tx: PrismaTx,
  booking: { id: string; customerName: string; status: string; staffId?: string | null; staff?: { name?: string | null } | null },
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
}
