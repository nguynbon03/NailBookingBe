import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser } from "@/lib/auth";
import { bookingInclude, serializeBooking } from "@/lib/booking-workflow";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const staffPortalRoles = new Set(["ADMIN", "MANAGER", "STAFF"]);

export async function GET(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || !staffPortalRoles.has(authUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const searchParams = req.nextUrl.searchParams;
  const from = searchParams.get("from") || new Date().toISOString().slice(0, 10);
  const to = searchParams.get("to") || from;

  const start = new Date(from);
  const end = new Date(to);
  end.setHours(23, 59, 59, 999);

  const staffList = await prisma.staff.findMany({
    where: { active: true },
    select: { id: true, name: true, avatar: true, role: true },
    orderBy: { name: "asc" },
  });

  const bookings = await prisma.booking.findMany({
    where: {
      archivedAt: null,
      date: { gte: start, lte: end },
    },
    include: bookingInclude,
    orderBy: [{ date: "asc" }, { time: "asc" }],
  });

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

  return NextResponse.json({
    range: { from, to },
    staff: staffList,
    schedule,
  });
}
