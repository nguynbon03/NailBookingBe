import { NextRequest, NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
import { prisma } from "@/lib/prisma";
import { lockSlot, unlockSlot } from "@/lib/redis";

const PROMO_CODES: Record<string, number> = {
  NAIL20: 0.2,
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { customerName, customerPhone, customerEmail, date, time, serviceIds, staffId, promoCode, discount, notes } = body;

    // Lock time slot with Redis
    const locked = await lockSlot(date, time, 600);
    if (!locked) {
      return NextResponse.json({ error: "Time slot is already taken" }, { status: 409 });
    }

    // Calculate total price
    const services = await prisma.service.findMany({ where: { id: { in: serviceIds } } });
    let totalPrice = services.reduce((sum: number, s: { price: any }) => sum + Number(s.price), 0);

    // Apply discount if promoCode is provided
    let discountAmount = 0;
    if (promoCode) {
      const promoRate = PROMO_CODES[promoCode.toUpperCase()];
      if (promoRate) {
        discountAmount = Math.round(totalPrice * promoRate * 100) / 100;
        totalPrice = Math.round((totalPrice - discountAmount) * 100) / 100;
      }
    } else if (discount && Number(discount) > 0) {
      discountAmount = Number(discount);
      totalPrice = Math.round((totalPrice - discountAmount) * 100) / 100;
    }
    if (totalPrice < 0) totalPrice = 0;

    // Create booking
    const booking = await prisma.booking.create({
      data: {
        customerName,
        customerPhone,
        customerEmail,
        date: new Date(date),
        time,
        staffId: staffId || null,
        totalPrice,
        discount: discountAmount > 0 ? discountAmount : null,
        promoCode: promoCode || null,
        notes,
        services: { create: serviceIds.map((sid: string) => ({ serviceId: sid })) },
      },
    });

    // Create revenue record with discount info
    await prisma.revenue.create({
      data: { date: new Date(date), amount: totalPrice, category: "SERVICE", discountApplied: discountAmount > 0, bookingId: booking.id },
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
