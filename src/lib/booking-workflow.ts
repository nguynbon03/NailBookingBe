import { BookingStatus, PrismaClient } from "@prisma/client";

type PrismaTx = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

type BookingForRevenue = {
  id: string;
  date: Date;
  status: string;
  totalPrice: unknown;
  discount: unknown | null;
  promoCode: string | null;
};

const REVENUE_STATUSES = new Set(["CONFIRMED", "COMPLETED"]);
export const COUNTED_BOOKING_STATUSES = ["CONFIRMED", "COMPLETED"] as const;

export function shouldCountRevenue(status: string) {
  return REVENUE_STATUSES.has(status);
}

export function serializeBooking(booking: any) {
  return {
    ...booking,
    totalPrice: Number(booking.totalPrice),
    numPeople: booking.numPeople || 1,
    discount: booking.discount == null ? null : Number(booking.discount),
    services: booking.services?.map((item: any) => ({
      ...item,
      service: item.service ? { ...item.service, price: Number(item.service.price) } : item.service,
    })) || [],
  };
}

export const bookingInclude = {
  services: { include: { service: true } },
  staff: true,
  requestedStaff: true,
  user: { select: { id: true, email: true, name: true, role: true } },
  review: true,
};

export async function syncBookingRevenue(tx: PrismaTx, booking: BookingForRevenue) {
  const existingCount = await tx.revenue.count({ where: { bookingId: booking.id } });
  const amount = Number(booking.totalPrice || 0);
  const discountApplied = Number(booking.discount || 0) > 0;

  if (shouldCountRevenue(booking.status)) {
    if (existingCount === 0) {
      await tx.revenue.create({
        data: {
          date: booking.date,
          amount,
          category: "SERVICE",
          discountApplied,
          bookingId: booking.id,
        },
      });
      if (booking.promoCode) {
        await tx.promoCode.updateMany({
          where: { code: booking.promoCode },
          data: { usedCount: { increment: 1 } },
        });
      }
    } else {
      await tx.revenue.updateMany({
        where: { bookingId: booking.id },
        data: { date: booking.date, amount, category: "SERVICE", discountApplied },
      });
    }
    return;
  }

  if (existingCount > 0) {
    await tx.revenue.deleteMany({ where: { bookingId: booking.id } });
    if (booking.promoCode) {
      await tx.promoCode.updateMany({
        where: { code: booking.promoCode, usedCount: { gt: 0 } },
        data: { usedCount: { decrement: 1 } },
      });
    }
  }
}

export async function updateBookingStatusWithRevenue(
  tx: PrismaTx,
  id: string,
  status: string,
  extraData: Record<string, unknown> = {}
) {
  const data: Record<string, unknown> = { ...extraData, status: status as BookingStatus };
  if (status === "CANCELLED") {
    data.cancellationReason = String(data.cancellationReason || "No Reason");
  } else {
    data.cancellationReason = null;
  }

  const booking = await tx.booking.update({
    where: { id },
    data,
    include: bookingInclude,
  });

  await syncBookingRevenue(tx, booking);
  return booking;
}
