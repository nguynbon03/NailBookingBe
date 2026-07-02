import { PrismaClient } from "@prisma/client";
import { queueCustomerBookingNotification } from "@/lib/customer-notifications";
import { queueCustomerWebsiteNotification, queueStaffBookingEmail } from "@/lib/internal-notifications";

type PrismaTx = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

function dayText(booking: any) {
  return booking.date instanceof Date ? booking.date.toISOString().slice(0, 10) : String(booking.date || "").slice(0, 10);
}

function staffTargetIds(booking: any) {
  const ids = new Set<string>();
  if (booking.staffId) ids.add(String(booking.staffId));
  if (booking.requestedStaffId) ids.add(String(booking.requestedStaffId));
  return Array.from(ids);
}

export async function notifyBookingCreated(tx: PrismaTx, booking: any, paymentTransferUrl?: string, depositReasons: string[] = []) {
  const day = dayText(booking);
  const depositRequired = Boolean(booking.depositRequired || paymentTransferUrl);
  const reasonText = depositReasons.length ? ` Reason: ${depositReasons.join(", ")}.` : "";
  const requestedStaffName = booking.requestedStaff?.name ? ` Requested staff: ${booking.requestedStaff.name}.` : "";
  const data: any[] = [
    {
      audience: "ADMIN",
      bookingId: booking.id,
      staffId: booking.requestedStaffId || null,
      type: depositRequired ? "BOOKING_DEPOSIT_REQUIRED" : "BOOKING_REQUEST_CREATED",
      title: depositRequired ? "New booking needs deposit" : "New booking request",
      message: depositRequired
        ? `${booking.customerName} requested ${day} at ${booking.time}.${requestedStaffName} Anti-spam protection requires a deposit before staff assignment.${reasonText}`
        : `${booking.customerName} requested ${day} at ${booking.time}.${requestedStaffName} Staff can accept this booking from Staff Portal.`,
    },
  ];

  if (!depositRequired) {
    const targets = staffTargetIds(booking);
    for (const staffId of targets) {
      data.push({
        audience: "STAFF",
        staffId,
        bookingId: booking.id,
        type: "BOOKING_AVAILABLE_FOR_STAFF",
        title: "New booking request for you",
        message: `${booking.customerName} requested ${day} at ${booking.time}. Open Staff Portal and accept if you can take this job.`,
      });
    }
  }

  await tx.notification.createMany({ data });
  await queueCustomerWebsiteNotification(
    tx,
    booking,
    depositRequired ? "Deposit needed for your booking" : "Booking request received",
    depositRequired
      ? `Your booking request for ${day} at ${booking.time} was received. Please complete the secure deposit step so the shop can assign staff.`
      : `Your booking request for ${day} at ${booking.time} was received. Staff have been notified and you will see updates here in real time.`,
    depositRequired ? "CUSTOMER_DEPOSIT_REQUIRED" : "CUSTOMER_BOOKING_REQUEST_CREATED"
  );
  if (!depositRequired) {
    const targets = staffTargetIds(booking);
    if (targets.length) {
      await queueStaffBookingEmail(tx, booking, "New booking request for you", "Open Staff Portal to accept if you can take this job.", targets);
    }
  }
  await queueCustomerBookingNotification(tx, { ...booking, paymentTransferUrl }, depositRequired ? "payment_transfer_link" : "booking_created");
}

export async function notifyBookingStatusChanged(
  tx: PrismaTx,
  booking: any,
  actorName: string
) {
  const day = dayText(booking);
  const staffName = booking.staff?.name || booking.requestedStaff?.name || actorName;
  const base = `${booking.customerName}: ${booking.status}${staffName ? ` by ${staffName}` : ""}.`;
  const data: any[] = [
    {
      audience: "ADMIN",
      staffId: booking.staffId || booking.requestedStaffId || null,
      bookingId: booking.id,
      type: "BOOKING_STATUS_CHANGED",
      title: `Booking ${String(booking.status).toLowerCase()}`,
      message: booking.status === "CANCELLED"
        ? `${booking.customerName}'s booking for ${day} at ${booking.time} was cancelled. Slot is released. Reason: ${booking.cancellationReason || "No reason"}.`
        : base,
    },
  ];

  const targets = staffTargetIds(booking);
  if (booking.status === "CANCELLED") {
    for (const staffId of targets) {
      data.push({
        audience: "STAFF",
        staffId,
        bookingId: booking.id,
        type: "STAFF_BOOKING_CANCELLED",
        title: "Customer booking cancelled",
        message: `${booking.customerName}'s booking for ${day} at ${booking.time} was cancelled and the slot is now open. Reason: ${booking.cancellationReason || "No reason"}.`,
      });
    }
  } else if (booking.staffId) {
    data.push({
      audience: "STAFF",
      staffId: booking.staffId,
      bookingId: booking.id,
      type: "STAFF_BOOKING_UPDATED",
      title: `Booking ${String(booking.status).toLowerCase()}`,
      message: base,
    });
  }

  await tx.notification.createMany({ data });

  await queueCustomerWebsiteNotification(
    tx,
    booking,
    booking.status === "CONFIRMED" ? "Booking confirmed" : booking.status === "CANCELLED" ? "Booking cancelled" : booking.status === "NO_SHOW" ? "Booking marked no-show" : `Booking ${String(booking.status).toLowerCase()}`,
    booking.status === "CANCELLED"
      ? `Your booking for ${day} at ${booking.time} was cancelled. Reason: ${booking.cancellationReason || "No reason"}.`
      : booking.status === "CONFIRMED"
        ? `Your booking for ${day} at ${booking.time} is confirmed with ${staffName || "the shop"}.`
        : `${booking.customerName}, your booking for ${day} at ${booking.time} is now ${booking.status}.`,
    `CUSTOMER_BOOKING_${String(booking.status || "UPDATED")}`
  );
  const staffEmailTargets = booking.status === "CANCELLED"
    ? targets
    : booking.staffId
      ? [booking.staffId]
      : [];
  if (staffEmailTargets.length) {
    await queueStaffBookingEmail(tx, booking, `Booking ${String(booking.status).toLowerCase()}`, booking.status === "CANCELLED" ? "This slot has been released." : "Check Staff Portal for the live schedule.", staffEmailTargets);
  }

  if (booking.status === "CONFIRMED") {
    await queueCustomerBookingNotification(tx, booking, "booking_confirmed");
  } else if (booking.status === "CANCELLED") {
    await queueCustomerBookingNotification(tx, booking, "booking_cancelled");
  } else if (booking.status === "NO_SHOW") {
    await queueCustomerBookingNotification(tx, booking, "booking_no_show");
  }
}
