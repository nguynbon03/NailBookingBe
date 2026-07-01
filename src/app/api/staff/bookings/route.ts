import { NextRequest, NextResponse } from "next/server";
import { BookingStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAuthUser } from "@/lib/auth";
import { bookingInclude, serializeBooking, updateBookingStatusWithRevenue } from "@/lib/booking-workflow";
import { isStaffAvailableAndFree } from "@/lib/availability";
import { notifyBookingStatusChanged } from "@/lib/notifications";
import { deliverPendingCustomerNotifications } from "@/lib/customer-notifications";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const staffPortalRoles = new Set(["ADMIN", "MANAGER", "STAFF"]);

function normalizeInternalReason(value: unknown) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 240) || "Staff cannot take this job";
}

async function resolveStaffProfile(user: { email: string; role: string }) {
  if (user.role === "STAFF") {
    return prisma.staff.findFirst({ where: { email: user.email, active: true } });
  }
  return prisma.staff.findFirst({ where: { email: user.email } });
}

function isOwnBooking(existing: { staffId: string | null }, staffProfile: { id: string } | null) {
  return Boolean(staffProfile && existing.staffId === staffProfile.id);
}

export async function GET(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || !staffPortalRoles.has(authUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const staffProfile = await resolveStaffProfile({ email: authUser.email, role: authUser.role });
  if (authUser.role === "STAFF" && !staffProfile) {
    return NextResponse.json({ error: "Staff profile not found for this login" }, { status: 403 });
  }

  const searchParams = req.nextUrl.searchParams;
  const scope = searchParams.get("scope") || "dashboard";

  const staffVisibilityWhere = staffProfile
    ? { OR: [{ requestedStaffId: null }, { requestedStaffId: staffProfile.id }] }
    : {};
  const availableWhere = {
    staffId: null,
    archivedAt: null,
    emailVerifiedAt: { not: null },
    AND: [
      staffVisibilityWhere,
      {
        OR: [
          { status: "PENDING" as BookingStatus, depositRequired: false },
          { status: "CONFIRMED" as BookingStatus },
        ],
      },
    ],
  };

  const mineWhere = staffProfile
    ? { staffId: staffProfile.id, status: { in: ["CONFIRMED"] as BookingStatus[] }, archivedAt: null }
    : { status: { in: ["CONFIRMED"] as BookingStatus[] }, archivedAt: null };

  if (scope === "available") {
    const availableBookings = await prisma.booking.findMany({
      where: availableWhere,
      include: bookingInclude,
      orderBy: [{ date: "asc" }, { time: "asc" }],
    });
    return NextResponse.json({ staffProfile, availableBookings: availableBookings.map(serializeBooking) });
  }

  if (scope === "mine") {
    const myBookings = await prisma.booking.findMany({
      where: mineWhere,
      include: bookingInclude,
      orderBy: [{ date: "asc" }, { time: "asc" }],
    });
    return NextResponse.json({ staffProfile, myBookings: myBookings.map(serializeBooking) });
  }

  const [availableBookings, myBookings, completedToday] = await Promise.all([
    prisma.booking.findMany({ where: availableWhere, include: bookingInclude, orderBy: [{ date: "asc" }, { time: "asc" }] }),
    prisma.booking.findMany({ where: mineWhere, include: bookingInclude, orderBy: [{ date: "asc" }, { time: "asc" }] }),
    staffProfile
      ? prisma.booking.count({ where: { staffId: staffProfile.id, status: "COMPLETED", archivedAt: null } })
      : prisma.booking.count({ where: { status: "COMPLETED", archivedAt: null } }),
  ]);

  return NextResponse.json({
    staffProfile,
    availableBookings: availableBookings.map(serializeBooking),
    myBookings: myBookings.map(serializeBooking),
    stats: {
      available: availableBookings.length,
      assigned: myBookings.length,
      completed: completedToday,
    },
  });
}

export async function PUT(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || !staffPortalRoles.has(authUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const id = String(body.id || "");
  const action = String(body.action || "");
  if (!id || !action) {
    return NextResponse.json({ error: "Invalid staff booking action" }, { status: 400 });
  }

  const staffProfile = await resolveStaffProfile({ email: authUser.email, role: authUser.role });
  if (authUser.role === "STAFF" && !staffProfile) {
    return NextResponse.json({ error: "Staff profile not found for this login" }, { status: 403 });
  }

  const existing = await prisma.booking.findUnique({ where: { id }, include: { staff: true, services: { include: { service: true } } } });
  if (!existing) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  if (existing.archivedAt) return NextResponse.json({ error: "Archived bookings cannot be changed from Staff Portal" }, { status: 409 });

  if (action === "claim" || action === "accept") {
    const canAcceptOpenRequest = existing.status === "PENDING" && Boolean(existing.emailVerifiedAt);
    const canAcceptReplacementJob = existing.status === "CONFIRMED" && !existing.staffId;
    if (!canAcceptOpenRequest && !canAcceptReplacementJob) {
      return NextResponse.json({ error: "Only verified open booking requests or replacement jobs can be accepted by staff" }, { status: 403 });
    }
    if (existing.status === "PENDING" && (existing as any).depositRequired && !(existing as any).paymentConfirmedAt) {
      return NextResponse.json({ error: "This booking requires deposit confirmation before staff can accept it" }, { status: 403 });
    }
    if (existing.staffId && (!staffProfile || existing.staffId !== staffProfile.id)) {
      return NextResponse.json({ error: "This booking is already assigned to another staff member" }, { status: 409 });
    }
    if (!staffProfile) return NextResponse.json({ error: "Staff profile is required to accept a booking" }, { status: 403 });
    if (existing.requestedStaffId && existing.requestedStaffId !== staffProfile.id && authUser.role === "STAFF") {
      return NextResponse.json({ error: "This booking was requested for another staff member" }, { status: 403 });
    }

    const duration = (existing.services || []).reduce((sum: number, item: any) => sum + Number(item.service?.duration || 0), 0) || 30;
    const available = await isStaffAvailableAndFree(prisma, staffProfile.id, existing.date, existing.time, duration, existing.id);
    if (!available) {
      return NextResponse.json({ error: "You are not available for this booking time" }, { status: 409 });
    }

    const booking = await prisma.$transaction(async (tx) => {
      const updated = await updateBookingStatusWithRevenue(tx, id, "CONFIRMED", {
        staffId: staffProfile.id,
        staffRejectedAt: null,
        staffRejectionReason: null,
        staffRejectionBy: null,
        paymentHoldStaffId: null,
        paymentConfirmedAt: (existing as any).depositRequired ? ((existing as any).paymentConfirmedAt || new Date()) : null,
        paymentConfirmedBy: (existing as any).depositRequired ? ((existing as any).paymentConfirmedBy || staffProfile.name) : null,
      });
      await notifyBookingStatusChanged(tx, updated, staffProfile.name);
      return updated;
    });
    await deliverPendingCustomerNotifications(prisma, booking.id);
    return NextResponse.json({ booking: serializeBooking(booking) });
  }

  if (action === "reject") {
    const reason = normalizeInternalReason(body.reason || body.cancellationReason);
    if (!reason) return NextResponse.json({ error: "Reject reason is required" }, { status: 400 });
    if (!isOwnBooking(existing, staffProfile)) {
      return NextResponse.json({ error: "Staff can only reject a job assigned to them" }, { status: 403 });
    }

    const booking = await prisma.$transaction(async (tx) => {
      const updated = await tx.booking.update({
        where: { id },
        data: {
          staffId: null,
          staffRejectedAt: new Date(),
          staffRejectionReason: reason,
          staffRejectionBy: staffProfile?.name || authUser.name,
        },
        include: bookingInclude,
      });
      await tx.notification.createMany({
        data: [
          {
            audience: "ADMIN",
            staffId: staffProfile?.id || null,
            bookingId: id,
            type: "STAFF_REJECTED_JOB",
            title: "Urgent: staff rejected assigned job",
            message: `${staffProfile?.name || authUser.name} cannot take ${updated.customerName}'s booking on ${updated.date.toISOString().slice(0, 10)} at ${updated.time}. Reason: ${reason}. Admin/Manager: reassign another staff member now, or contact the customer if no replacement is available. The booking is still confirmed but unassigned and visible again in Staff Portal open requests.`,
          },
          {
            audience: "STAFF",
            staffId: null,
            bookingId: id,
            type: "BOOKING_NEEDS_REPLACEMENT_STAFF",
            title: "Replacement staff needed",
            message: `${updated.customerName}'s confirmed booking on ${updated.date.toISOString().slice(0, 10)} at ${updated.time} needs a replacement staff member. Open Staff Portal and accept if you can take it.`,
          },
        ],
      });
      return updated;
    });
    return NextResponse.json({ booking: serializeBooking(booking) });
  }

  const actionToStatus: Record<string, BookingStatus> = {
    complete: "COMPLETED",
    no_show: "NO_SHOW",
  };
  const targetStatus = actionToStatus[action];
  if (!targetStatus) {
    return NextResponse.json({ error: "Staff can only accept, reject, complete, or mark no-show. Customer confirmation/cancellation is owner/manager only." }, { status: 400 });
  }

  if (!isOwnBooking(existing, staffProfile)) {
    return NextResponse.json({ error: "Staff can only update their own assigned bookings" }, { status: 403 });
  }
  if (existing.status !== "CONFIRMED") {
    return NextResponse.json({ error: "Only confirmed assigned bookings can be completed or marked no-show" }, { status: 409 });
  }

  const booking = await prisma.$transaction(async (tx) => {
    const updated = await updateBookingStatusWithRevenue(tx, id, targetStatus, {});
    await notifyBookingStatusChanged(tx, updated, authUser.name);
    return updated;
  });
  await deliverPendingCustomerNotifications(prisma, booking.id);
  return NextResponse.json({ booking: serializeBooking(booking) });
}
