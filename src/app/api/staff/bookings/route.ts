import { NextRequest, NextResponse } from "next/server";
import { BookingStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAuthUser, isAdminRole } from "@/lib/auth";
import { bookingInclude, serializeBooking, updateBookingStatusWithRevenue } from "@/lib/booking-workflow";
import { notifyBookingStatusChanged } from "@/lib/notifications";
import { deliverPendingCustomerNotifications } from "@/lib/customer-notifications";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const staffPortalRoles = new Set(["ADMIN", "MANAGER", "STAFF"]);
const actionToStatus: Record<string, BookingStatus> = {
  claim: "CONFIRMED",
  confirm: "CONFIRMED",
  complete: "COMPLETED",
  cancel: "CANCELLED",
  no_show: "NO_SHOW",
  reopen: "PENDING",
};

function normalizeCancellationReason(value: unknown) {
  const reason = String(value || "").trim().replace(/\s+/g, " ").slice(0, 240);
  if (!reason || reason === "Other") return "No Reason";
  return reason;
}

async function resolveStaffProfile(user: { email: string; role: string }) {
  if (user.role === "STAFF") {
    return prisma.staff.findFirst({ where: { email: user.email, active: true } });
  }
  return prisma.staff.findFirst({ where: { email: user.email } });
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
  const upcomingStatuses: BookingStatus[] = ["CONFIRMED"];

  const availableWhere = {
    status: "CONFIRMED" as BookingStatus,
    staffId: null,
  };

  const mineWhere = staffProfile
    ? { staffId: staffProfile.id, status: { in: upcomingStatuses } }
    : { status: { in: upcomingStatuses } };

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
      ? prisma.booking.count({ where: { staffId: staffProfile.id, status: "COMPLETED" } })
      : prisma.booking.count({ where: { status: "COMPLETED" } }),
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
  const targetStatus = actionToStatus[action];
  if (!id || !targetStatus) {
    return NextResponse.json({ error: "Invalid staff booking action" }, { status: 400 });
  }

  const staffProfile = await resolveStaffProfile({ email: authUser.email, role: authUser.role });
  if (authUser.role === "STAFF" && !staffProfile) {
    return NextResponse.json({ error: "Staff profile not found for this login" }, { status: 403 });
  }

  const existing = await prisma.booking.findUnique({ where: { id }, include: { staff: true } });
  if (!existing) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  if (targetStatus === "CONFIRMED" && !existing.emailVerifiedAt) {
    return NextResponse.json({ error: "Customer email is not verified yet. Ask the customer to click the verification email before confirming." }, { status: 409 });
  }

  const isAdminLike = isAdminRole(authUser.role);
  const extraData: Record<string, unknown> = {};
  if (action === "cancel") extraData.cancellationReason = normalizeCancellationReason(body.cancellationReason);

  if (action === "claim" || action === "confirm") {
    if (authUser.role === "STAFF" && existing.status !== "CONFIRMED") {
      return NextResponse.json({ error: "Admin must confirm deposit before staff can claim this booking" }, { status: 403 });
    }
    if (staffProfile) {
      if (existing.staffId && existing.staffId !== staffProfile.id && !isAdminLike) {
        return NextResponse.json({ error: "This booking is already assigned to another staff member" }, { status: 409 });
      }
      extraData.staffId = staffProfile.id;
    } else if (body.staffId) {
      extraData.staffId = String(body.staffId);
    }
  } else if (authUser.role === "STAFF") {
    if (!staffProfile || existing.staffId !== staffProfile.id) {
      return NextResponse.json({ error: "Staff can only update their own bookings" }, { status: 403 });
    }
  }

  const booking = await prisma.$transaction(async (tx) => {
    const updated = await updateBookingStatusWithRevenue(tx, id, targetStatus, extraData);
    await notifyBookingStatusChanged(tx, updated, authUser.name);
    return updated;
  });
  await deliverPendingCustomerNotifications(prisma, booking.id);
  return NextResponse.json({ booking: serializeBooking(booking) });
}
