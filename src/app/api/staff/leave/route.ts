import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, isAdminRole, isStaffPortalRole } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VALID_REVIEW_STATUSES = new Set(["APPROVED", "REJECTED"]);

function dateOnly(value: string | Date) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function daysInclusive(start: Date, end: Date) {
  return Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
}

function cleanText(value: unknown, fallback = "No reason") {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 300) || fallback;
}

async function resolveStaffProfile(user: { email: string; role: string }, requestedStaffId?: string | null) {
  if (isAdminRole(user.role) && requestedStaffId) {
    return prisma.staff.findFirst({ where: { id: requestedStaffId, active: true } });
  }
  return prisma.staff.findFirst({ where: { email: user.email, active: true } });
}

function serializeLeave(row: any) {
  return {
    ...row,
    startDate: row.startDate?.toISOString?.() || row.startDate,
    endDate: row.endDate?.toISOString?.() || row.endDate,
    createdAt: row.createdAt?.toISOString?.() || row.createdAt,
    updatedAt: row.updatedAt?.toISOString?.() || row.updatedAt,
    reviewedAt: row.reviewedAt?.toISOString?.() || row.reviewedAt,
  };
}

export async function GET(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || !isStaffPortalRole(authUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const params = req.nextUrl.searchParams;
  const status = params.get("status");
  const scopeAll = params.get("scope") === "all" || params.get("all") === "1";
  const where: any = {};
  if (status) where.status = status.toUpperCase();

  if (isAdminRole(authUser.role) && scopeAll) {
    if (params.get("staffId")) where.staffId = params.get("staffId");
  } else {
    const staff = await resolveStaffProfile(authUser);
    if (!staff) return NextResponse.json({ error: "Staff profile not found" }, { status: 403 });
    where.staffId = staff.id;
  }

  const leaveRequests = await prisma.staffLeaveRequest.findMany({
    where,
    include: { staff: { select: { id: true, name: true, email: true, role: true } } },
    orderBy: [{ createdAt: "desc" }],
    take: 100,
  });

  return NextResponse.json({ leaveRequests: leaveRequests.map(serializeLeave) });
}

export async function POST(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || !isStaffPortalRole(authUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const staff = await resolveStaffProfile(authUser, body.staffId ? String(body.staffId) : null);
  if (!staff) return NextResponse.json({ error: "Staff profile not found" }, { status: 403 });

  const startDate = dateOnly(body.startDate);
  const endDate = dateOnly(body.endDate || body.startDate);
  if (!startDate || !endDate) return NextResponse.json({ error: "Start date and end date are required" }, { status: 400 });
  if (endDate < startDate) return NextResponse.json({ error: "End date must be after start date" }, { status: 400 });

  const reason = cleanText(body.reason, "Leave requested");
  const leaveRequest = await prisma.$transaction(async (tx) => {
    const created = await tx.staffLeaveRequest.create({
      data: {
        staffId: staff.id,
        startDate,
        endDate,
        daysCount: daysInclusive(startDate, endDate),
        reason,
        status: "PENDING",
      },
      include: { staff: { select: { id: true, name: true, email: true, role: true } } },
    });

    await tx.notification.create({
      data: {
        audience: "ADMIN",
        staffId: staff.id,
        type: "STAFF_LEAVE_REQUESTED",
        title: "Staff requested leave",
        message: `${staff.name} requested ${created.daysCount} day(s) off from ${startDate.toISOString().slice(0, 10)} to ${endDate.toISOString().slice(0, 10)}. Reason: ${reason}. Review it before planning staff schedule.`,
      },
    });

    return created;
  });

  return NextResponse.json({ leaveRequest: serializeLeave(leaveRequest) });
}

export async function PUT(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || !isAdminRole(authUser.role)) {
    return NextResponse.json({ error: "Only ADMIN/MANAGER can review leave requests" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const id = String(body.id || "");
  const status = String(body.status || "").trim().toUpperCase();
  if (!id || !VALID_REVIEW_STATUSES.has(status)) {
    return NextResponse.json({ error: "Leave request id and APPROVED/REJECTED status are required" }, { status: 400 });
  }

  const existing = await prisma.staffLeaveRequest.findUnique({ where: { id }, include: { staff: true } });
  if (!existing) return NextResponse.json({ error: "Leave request not found" }, { status: 404 });

  const managerNote = body.managerNote ? cleanText(body.managerNote, "") : null;
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
      where: { id },
      data: {
        status,
        managerNote,
        reviewedBy: authUser.name || authUser.email,
        reviewedAt: new Date(),
      },
      include: { staff: { select: { id: true, name: true, email: true, role: true } } },
    });

    await tx.notification.create({
      data: {
        audience: "STAFF",
        staffId: existing.staffId,
        type: `STAFF_LEAVE_${status}`,
        title: status === "APPROVED" ? "Leave request approved" : "Leave request rejected",
        message: `${authUser.name || "Manager"} ${status.toLowerCase()} your leave from ${existing.startDate.toISOString().slice(0, 10)} to ${existing.endDate.toISOString().slice(0, 10)}.${managerNote ? ` Note: ${managerNote}` : ""}`,
      },
    });

    if (status === "APPROVED" && affectedBookings.length > 0) {
      await tx.notification.create({
        data: {
          audience: "ADMIN",
          staffId: existing.staffId,
          type: "APPROVED_LEAVE_HAS_BOOKING_CONFLICTS",
          title: "Approved leave has assigned bookings",
          message: `${existing.staff.name} has ${affectedBookings.length} confirmed booking(s) during approved leave. Reassign them before the appointment time.`,
        },
      });
    }

    return updated;
  });

  return NextResponse.json({ leaveRequest: serializeLeave(leaveRequest), affectedBookings });
}

export async function DELETE(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || !isStaffPortalRole(authUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id, hardDelete } = await req.json().catch(() => ({}));
  if (!id) return NextResponse.json({ error: "Leave request id is required" }, { status: 400 });

  const existing = await prisma.staffLeaveRequest.findUnique({ where: { id: String(id) }, include: { staff: true } });
  if (!existing) return NextResponse.json({ error: "Leave request not found" }, { status: 404 });

  const isOwner = existing.staff.email === authUser.email;
  const isAdmin = isAdminRole(authUser.role);
  if (!isOwner && !isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  if (isAdmin && (hardDelete !== false || !isOwner)) {
    await prisma.$transaction(async (tx) => {
      await tx.staffLeaveRequest.delete({ where: { id: String(id) } });
      await tx.notification.create({
        data: {
          audience: "ADMIN",
          staffId: existing.staffId,
          type: "STAFF_LEAVE_DELETED",
          title: "Leave request deleted",
          message: `${authUser.name || "Manager"} deleted ${existing.staff.name}'s leave request from ${existing.startDate.toISOString().slice(0, 10)} to ${existing.endDate.toISOString().slice(0, 10)} to clean the admin list.`,
        },
      });
    });
    return NextResponse.json({ success: true, deleted: true, id: String(id) });
  }

  const leaveRequest = await prisma.$transaction(async (tx) => {
    const updated = await tx.staffLeaveRequest.update({
      where: { id: String(id) },
      data: { status: "CANCELLED", managerNote: isOwner ? "Cancelled by staff" : `Cancelled by ${authUser.name || authUser.email}` },
      include: { staff: { select: { id: true, name: true, email: true, role: true } } },
    });

    await tx.notification.create({
      data: {
        audience: isOwner ? "ADMIN" : "STAFF",
        staffId: existing.staffId,
        type: "STAFF_LEAVE_CANCELLED",
        title: "Leave request cancelled",
        message: `${existing.staff.name}'s leave request from ${existing.startDate.toISOString().slice(0, 10)} to ${existing.endDate.toISOString().slice(0, 10)} was cancelled.`,
      },
    });

    return updated;
  });

  return NextResponse.json({ leaveRequest: serializeLeave(leaveRequest), deleted: false });
}
