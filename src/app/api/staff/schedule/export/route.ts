import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser } from "@/lib/auth";
import { bookingInclude, serializeBooking } from "@/lib/booking-workflow";

export const dynamic = "force-dynamic";

function toICSDate(dateStr: string, timeStr: string) {
  const dt = new Date(`${dateStr}T${timeStr}:00`);
  return dt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export async function GET(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const searchParams = req.nextUrl.searchParams;
  const staffId = searchParams.get("staffId");
  const from = searchParams.get("from") || new Date().toISOString().slice(0, 10);
  const to = searchParams.get("to") || from;
  const format = searchParams.get("format") || "json";

  const start = new Date(from);
  const end = new Date(to);
  end.setHours(23, 59, 59, 999);

  const where: any = { archivedAt: null, date: { gte: start, lte: end } };
  if (staffId) where.staffId = staffId;

  const bookings = await prisma.booking.findMany({
    where,
    include: bookingInclude,
    orderBy: [{ date: "asc" }, { time: "asc" }],
  });

  const events = bookings.map(b => {
    const s = serializeBooking(b);
    const services = s.services?.map((x: any) => x.service?.name).join(', ') || 'Service';
    return {
      uid: s.id + '@nailbooking',
      title: `${s.customerName} - ${services}`,
      start: `${s.date}T${s.time}:00`,
      end: `${s.date}T${s.time}:00`, // simple 1h, can improve
      description: `Status: ${s.status} | Phone: ${s.customerPhone} | Staff: ${s.staff?.name || 'TBD'} | Ref: ${s.paymentReference || ''}`,
      location: 'Nail Lounge Stokesley',
    };
  });

  if (format === 'ics') {
    const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    let ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//NailBooking//Staff Schedule//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
    ];
    events.forEach(ev => {
      ics.push('BEGIN:VEVENT');
      ics.push(`UID:${ev.uid}`);
      ics.push(`DTSTAMP:${now}`);
      ics.push(`DTSTART:${ev.start.replace(/[-:]/g,'').replace('Z','')}`);
      ics.push(`DTEND:${(ev.end || ev.start).replace(/[-:]/g,'').replace('Z','')}`);
      ics.push(`SUMMARY:${ev.title}`);
      ics.push(`DESCRIPTION:${ev.description.replace(/\n/g,'\\n')}`);
      ics.push(`LOCATION:${ev.location}`);
      ics.push('END:VEVENT');
    });
    ics.push('END:VCALENDAR');
    return new NextResponse(ics.join('\r\n'), {
      status: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="staff-schedule-${from}-${to}.ics"`,
      },
    });
  }

  return NextResponse.json({ from, to, staffId, events });
}
