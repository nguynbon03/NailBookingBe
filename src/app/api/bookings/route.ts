import { NextRequest, NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
import { prisma } from "@/lib/prisma";
import { lockSlot, unlockSlot } from "@/lib/redis";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { customerName, customerPhone, customerEmail, date, time, serviceIds, notes } = body;

    // Lock time slot with Redis
    const locked = await lockSlot(date, time, 600);
    if (!locked) {
      return NextResponse.json({ error: "Time slot is already taken" }, { status: 409 });
    }

    // Calculate total price
    const services = await prisma.service.findMany({ where: { id: { in: serviceIds } } });
    const totalPrice = services.reduce((sum: number, s: { price: any }) => sum + Number(s.price), 0);

    // Create booking
    const booking = await prisma.booking.create({
      data: {
        customerName,
        customerPhone,
        customerEmail,
        date: new Date(date),
        time,
        totalPrice,
        notes,
        services: { create: serviceIds.map((sid: string) => ({ serviceId: sid })) },
      },
    });

    // Create revenue record
    await prisma.revenue.create({
      data: { date: new Date(date), amount: totalPrice, category: "SERVICE", bookingId: booking.id },
    });

    return NextResponse.json({ booking, locked: true });
  } catch (e) {
    return NextResponse.json({ error: "Booking failed" }, { status: 500 });
  }
}

export async function GET() {
  const bookings = await prisma.booking.findMany({
    include: { services: { include: { service: true } } },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ bookings });
}
