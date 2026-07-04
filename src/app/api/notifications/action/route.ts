import { NextRequest, NextResponse } from "next/server";
import { BookingStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAuthUser, isAdminRole } from "@/lib/auth";
import { bookingInclude, serializeBooking, updateBookingStatusWithRevenue } from "@/lib/booking-workflow";
import { notifyBookingStatusChanged } from "@/lib/notifications";
import { deliverPendingCustomerNotifications } from "@/lib/customer-notifications";
import { queueOwnerLeaveEmail, queueStaffLeaveEmail } from "@/lib/internal-notifications";
import { cancelCalComBooking } from "@/lib/calcom";
import { cancelGoogleCalendarBooking } from "@/lib/google-calendar";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function cleanText(value: unknown, fallback = "") {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 300) || fallback;
}

function appendNote(existing: string | null | undefined, line: string) {
  const current = String(existing || "").trim();
  return [current, line].filter(Boolean).join("\n").slice(0, 4000);
}

function parseLeaveDates(message: string) {
  const match = String(message || "").match(/from\s+(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})/i);
  if (!match) return null;
  return {
    startDate: new Date(`${match[1]}T00:00:00.000Z`),
    endDate: new Date(`${match[2]}T00:00:00.000Z`),
  };
}

async function findLeaveRequest(notification: any) {
  if (notification.entityType === "STAFF_LEAVE" && notification.entityId) {
    const exact = await prisma.staffLeaveRequest.findUnique({ where: { id: notification.entityId }, include: { staff: true } });
    if (exact) return exact;
  }
  const dates = parseLeaveDates(notification.message || "");
  return prisma.staffLeaveRequest.findFirst({
    where: {
      staffId: notification.staffId || undefined,
      ...(dates ? { startDate: dates.startDate, endDate: dates.endDate } : {}),
    },
    include: { staff: true },
    orderBy: { createdAt: "desc" },
  });
}

async function reviewLeave(notification: any, status: "APPROVED" | "REJECTED", managerName: string, managerNote: string | null) {
  const existing = await findLeaveRequest(notification);
  if (!existing) throw new Error("Leave request not found for this inbox ticket");

  if (existing.status !== "PENDING") {
    await prisma.notification.deleteMany({ where: { audience: "ADMIN", entityType: "STAFF_LEAVE", entityId: existing.id } }).catch(() => null);
    await prisma.notification.deleteMany({ where: { id: notification.id } }).catch(() => null);
    return { leaveRequest: existing, affectedBookings: [], alreadyReviewed: true };
  }

  const affectedBookings = status === "APPROVED"
    ? await prisma.booking.findMany({
        where: {
          staffId: existing.staffId,
          status: "CONFIRMED",
          date: { gte: existing.startDate, lte: existing.endDate },
          archivedAt: null,
        },
        select: { id: true, customerName: true, date: true, time: true },
        orderBy: [{ date: "asc" }, { time: "asc" }],
      })
    : [];

  const leaveRequest = await prisma.$transaction(async (tx) => {
    const updated = await tx.staffLeaveRequest.update({
      where: { id: existing.id },
      data: {
        status,
        managerNote,
        reviewedBy: managerName,
        reviewedAt: new Date(),
      },
      include: { staff: { select: { id: true, name: true, email: true, role: true } } },
    });

    await tx.notification.deleteMany({ where: { audience: "ADMIN", entityType: "STAFF_LEAVE", entityId: existing.id } }).catch(() => null);
    await tx.notification.deleteMany({ where: { id: notification.id } }).catch(() => null);
    await tx.notification.deleteMany({
      where: {
        audience: "STAFF",
        staffId: existing.staffId,
        entityType: "STAFF_LEAVE",
        entityId: existing.id,
        type: { in: ["STAFF_LEAVE_APPROVED", "STAFF_LEAVE_REJECTED"] },
      },
    }).catch(() => null);

    await tx.notification.create({
      data: {
        audience: "STAFF",
        staffId: existing.staffId,
        entityType: "STAFF_LEAVE",
        entityId: existing.id,
        type: `STAFF_LEAVE_${status}`,
        title: status === "APPROVED" ? "Leave request approved" : "Leave request rejected",
        message: `${managerName} ${status.toLowerCase()} your leave from ${existing.startDate.toISOString().slice(0, 10)} to ${existing.endDate.toISOString().slice(0, 10)}.${managerNote ? ` Note: ${managerNote}` : ""}`,
      },
    });

    if (status === "APPROVED" && affectedBookings.length > 0) {
      await tx.notification.create({
        data: {
          audience: "ADMIN",
          staffId: existing.staffId,
          entityType: "STAFF_LEAVE",
          entityId: existing.id,
          type: "APPROVED_LEAVE_HAS_BOOKING_CONFLICTS",
          title: "Approved leave has assigned bookings",
          message: `${existing.staff.name} has ${affectedBookings.length} confirmed booking(s) during approved leave. Reassign them before the appointment time.`,
        },
      });
    }

    await queueStaffLeaveEmail(tx, updated, status === "APPROVED" ? "Leave request approved" : "Leave request rejected", managerNote || "");
    await queueOwnerLeaveEmail(
      tx,
      updated,
      status === "APPROVED" ? "Leave request approved" : "Leave request rejected",
      affectedBookings.length ? `${affectedBookings.length} assigned booking(s) overlap this approved leave. Reassign them.` : "Staff has been notified by website notification and email.",
    );

    return updated;
  });

  await deliverPendingCustomerNotifications(prisma, null, "internal_staff_leave_alert");
  return { leaveRequest, affectedBookings };
}

async function approveCancellation(notification: any, managerName: string) {
  if (!notification.bookingId) throw new Error("Booking id is missing on this cancellation ticket");
  const target = await prisma.booking.findUnique({ where: { id: notification.bookingId }, include: bookingInclude });
  if (!target) throw new Error("Booking not found for this cancellation ticket");

  if (target.status === "CANCELLED") {
    await prisma.notification.deleteMany({ where: { id: notification.id } }).catch(() => null);
    return { booking: target, alreadyCancelled: true };
  }
  if (["COMPLETED", "NO_SHOW"].includes(target.status)) {
    throw new Error("This booking can no longer be cancelled from inbox");
  }

  const booking = await prisma.$transaction(async (tx) => {
    const updated = await updateBookingStatusWithRevenue(tx, target.id, "CANCELLED" as BookingStatus, {
      cancellationReason: target.cancellationReason || `Customer cancellation approved by ${managerName}`,
      notes: appendNote(target.notes, `[Inbox ${new Date().toISOString()}] Customer cancellation approved by ${managerName}.`),
    });
    await notifyBookingStatusChanged(tx, updated, managerName);
    await tx.notification.delete({ where: { id: notification.id } }).catch(() => null);
    return updated;
  });

  await deliverPendingCustomerNotifications(prisma, booking.id);
  const calcomSync = await cancelCalComBooking(prisma, booking as any);
  const googleSync = await cancelGoogleCalendarBooking(prisma, booking as any);
  return { booking, calcomSync, googleSync };
}

async function keepBooking(notification: any, managerName: string) {
  if (notification.bookingId) {
    await prisma.booking.update({
      where: { id: notification.bookingId },
      data: {
        notes: {
          set: appendNote(
            (await prisma.booking.findUnique({ where: { id: notification.bookingId }, select: { notes: true } }))?.notes,
            `[Inbox ${new Date().toISOString()}] Cancellation request reviewed by ${managerName}; booking kept active.`,
          ),
        },
      },
    });
  }
  await prisma.notification.deleteMany({ where: { id: notification.id } }).catch(() => null);
}

async function acknowledge(notification: any) {
  await prisma.notification.deleteMany({ where: { id: notification.id } }).catch(() => null);
}

export async function POST(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || !isAdminRole(authUser.role)) return NextResponse.json({ error: "Only ADMIN/MANAGER can review inbox tickets" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const id = String(body.notificationId || body.id || "").trim();
  const action = String(body.action || "").trim();
  const managerName = authUser.name || authUser.email || "Manager";
  const managerNote = body.managerNote ? cleanText(body.managerNote, "") : null;

  if (!id || !action) return NextResponse.json({ error: "notificationId and action are required" }, { status: 400 });

  const notification = await prisma.notification.findFirst({ where: { id, audience: "ADMIN" } });
  if (!notification) return NextResponse.json({ error: "Inbox ticket not found" }, { status: 404 });

  try {
    if (action === "approveCancellation") {
      const result = await approveCancellation(notification, managerName);
      return NextResponse.json({
        ok: true,
        action,
        booking: serializeBooking(result.booking),
        alreadyCancelled: Boolean(result.alreadyCancelled),
        calcomSync: (result as any).calcomSync || null,
        googleSync: (result as any).googleSync || null,
      });
    }
    if (action === "keepBooking") {
      await keepBooking(notification, managerName);
      return NextResponse.json({ ok: true, action });
    }
    if (action === "approveLeave" || action === "rejectLeave") {
      const status = action === "approveLeave" ? "APPROVED" : "REJECTED";
      const result = await reviewLeave(notification, status, managerName, managerNote);
      return NextResponse.json({ ok: true, action, leaveRequest: result.leaveRequest, affectedBookings: result.affectedBookings, alreadyReviewed: Boolean((result as any).alreadyReviewed) });
    }
    if (action === "acknowledge") {
      await acknowledge(notification);
      return NextResponse.json({ ok: true, action });
    }
    return NextResponse.json({ error: "Unsupported inbox action" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Could not process inbox ticket" }, { status: 400 });
  }
}
