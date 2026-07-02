import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { bookingInclude, serializeBooking } from "@/lib/booking-workflow";
import { getAuthUser, isStaffPortalRole } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || !isStaffPortalRole(authUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const searchParams = req.nextUrl.searchParams;
  const from = searchParams.get("from") || new Date().toISOString().slice(0, 10);
  const to = searchParams.get("to") || from;

  const start = new Date(from);
  const end = new Date(to);
  end.setHours(23, 59, 59, 999);

  const [staffList, bookings, leaveRequests, availability] = await Promise.all([
    prisma.staff.findMany({
      where: { active: true },
      select: { id: true, name: true, avatar: true, role: true, email: true },
      orderBy: { name: "asc" },
    }),
    prisma.booking.findMany({
      where: {
        archivedAt: null,
        date: { gte: start, lte: end },
      },
      include: bookingInclude,
      orderBy: [{ date: "asc" }, { time: "asc" }],
    }),
    prisma.staffLeaveRequest.findMany({
      where: {
        startDate: { lte: end },
        endDate: { gte: start },
      },
      include: { staff: { select: { id: true, name: true, email: true, role: true } } },
      orderBy: [{ startDate: "asc" }, { createdAt: "desc" }],
    }),
    prisma.staffAvailability.findMany({
      where: {
        active: true,
        OR: [
          { date: null },
          { date: { gte: start, lte: end } },
        ],
      },
      orderBy: [{ date: "asc" }, { dayOfWeek: "asc" }, { startTime: "asc" }],
    }),
  ]);

  const schedule: Record<string, any[]> = {};
  staffList.forEach(staff => { schedule[staff.id] = []; });
  schedule["unassigned"] = [];

  bookings.forEach(b => {
    const serialized = serializeBooking(b);
    if (b.staffId && schedule[b.staffId]) {
      schedule[b.staffId].push(serialized);
    } else {
      schedule["unassigned"].push(serialized);
    }
  });

  const leaveByStaff: Record<string, any[]> = {};
  const availabilityByStaff: Record<string, any[]> = {};
  staffList.forEach((staff) => {
    leaveByStaff[staff.id] = [];
    availabilityByStaff[staff.id] = [];
  });

  leaveRequests.forEach((leave) => {
    if (!leaveByStaff[leave.staffId]) leaveByStaff[leave.staffId] = [];
    leaveByStaff[leave.staffId].push({
      ...leave,
      startDate: leave.startDate.toISOString(),
      endDate: leave.endDate.toISOString(),
      createdAt: leave.createdAt.toISOString(),
      updatedAt: leave.updatedAt.toISOString(),
      reviewedAt: leave.reviewedAt?.toISOString?.() || null,
    });
  });

  availability.forEach((slot) => {
    if (!availabilityByStaff[slot.staffId]) availabilityByStaff[slot.staffId] = [];
    availabilityByStaff[slot.staffId].push({
      ...slot,
      date: slot.date?.toISOString?.() || null,
      createdAt: slot.createdAt.toISOString(),
      updatedAt: slot.updatedAt.toISOString(),
    });
  });

  return NextResponse.json({
    range: { from, to },
    staff: staffList,
    schedule,
    leaves: leaveByStaff,
    availability: availabilityByStaff,
  });
}
