import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser } from "@/lib/auth";
import { bookingInclude, serializeBooking } from "@/lib/booking-workflow";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const searchParams = req.nextUrl.searchParams;
  const staffId = searchParams.get("staffId");
  const from = searchParams.get("from") || new Date().toISOString().slice(0, 10);
  const to = searchParams.get("to") || from;

  const start = new Date(from);
  const end = new Date(to);
  end.setHours(23, 59, 59, 999);

  const where: any = {
    archivedAt: null,
    date: { gte: start, lte: end },
  };
  if (staffId) where.staffId = staffId;

  const bookings = await prisma.booking.findMany({
    where,
    include: bookingInclude,
    orderBy: [{ date: "asc" }, { time: "asc" }],
  });

  const events = bookings.map(b => {
    const s = serializeBooking(b);
    return {
      title: `${s.customerName} - ${s.services?.map((x: any) => x.service?.name).join(', ') || 'Service'}`,
      start: `${s.date}T${s.time}:00`,
      duration: 60,
      description: `Status: ${s.status} | Phone: ${s.customerPhone} | Ref: ${s.paymentReference || ''}`,
    };
  });

  return NextResponse.json({ from, to, staffId, events });
}
