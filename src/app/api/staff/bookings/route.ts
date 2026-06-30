import { NextRequest, NextResponse } from "next/server";
import { BookingStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAuthUser } from "@/lib/auth";
import { bookingInclude, serializeBooking, updateBookingStatusWithRevenue } from "@/lib/booking-workflow";
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

  const availableWhere = {
    status: "CONFIRMED" as BookingStatus,
    staffId: null,
    archivedAt: null,
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

  const existing = await prisma.booking.findUnique({ where: { id }, include: { staff: true } });
  if (!existing) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  if (existing.archivedAt) return NextResponse.json({ error: "Archived bookings cannot be changed from Staff Portal" }, { status: 409 });

  if (action === "claim" || action === "accept") {
    if (existing.status !== "CONFIRMED" || !existing.emailVerifiedAt || !existing.paymentConfirmedAt) {
      return NextResponse.json({ error: "Owner/Manager must verify email and confirm payment before staff can accept the job" }, { status: 403 });
    }
    if (existing.staffId && (!staffProfile || existing.staffId !== staffProfile.id)) {
      return NextResponse.json({ error: "This booking is already assigned to another staff member" }, { status: 409 });
    }
    if (!staffProfile) return NextResponse.json({ error: "Staff profile is required to accept a job" }, { status: 403 });

    const booking = await prisma.$transaction(async (tx) => {
      const updated = await tx.booking.update({
        where: { id },
        data: { staffId: staffProfile.id, staffRejectedAt: null, staffRejectionReason: null, staffRejectionBy: null },
        include: bookingInclude,
      });
      await tx.notification.createMany({ data: [
        {
          audience: "ADMIN",
          staffId: staffProfile.id,
          bookingId: id,
          type: "STAFF_ACCEPTED_JOB",
          title: "Staff accepted job",
          message: `${staffProfile.name} accepted ${updated.customerName}'s booking. Customer was not re-confirmed; this is an internal assignment update.`,
        },
        {
          audience: "STAFF",
          staffId: staffProfile.id,
          bookingId: id,
          type: "STAFF_JOB_ASSIGNED",
          title: "Job added to your schedule",
          message: `You accepted ${updated.customerName}'s booking for ${updated.date.toISOString().slice(0, 10)} at ${updated.time}.`,
        },
      ] });
      return updated;
    });
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
      await tx.notification.create({
        data: {
          audience: "ADMIN",
          staffId: staffProfile?.id || null,
          bookingId: id,
          type: "STAFF_REJECTED_JOB",
          title: "Staff rejected job",
          message: `${staffProfile?.name || authUser.name} cannot take ${updated.customerName}'s booking. Reason: ${reason}. Booking stays CONFIRMED and returns to the open staff pool. Customer was not cancelled.`,
        },
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
