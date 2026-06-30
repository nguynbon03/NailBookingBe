import { NextRequest, NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
import { prisma } from "@/lib/prisma";

const PROMO_CODES: Record<string, number> = {
  NAIL20: 0.2,
};

function normalizeServiceInputs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((v) => String(v || "").trim()).filter(Boolean)));
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      customerName,
      customerPhone,
      customerEmail,
      serviceIds,
      staffId,
      promoCode,
      discount,
      notes,
    } = body;
    const date = body.date;
    const time = body.time;

    if (!customerName || !customerPhone || !date || !time) {
      return NextResponse.json({ error: "Missing required booking fields" }, { status: 400 });
    }

    const serviceKeys = normalizeServiceInputs(serviceIds);
    if (!serviceKeys.length) {
      return NextResponse.json({ error: "At least one service is required" }, { status: 400 });
    }

    const requestedDate = new Date(date);
    const existingBooking = await prisma.booking.findFirst({
      where: {
        date: requestedDate,
        time,
        ...(staffId ? { staffId } : {}),
        status: { notIn: ["CANCELLED", "NO_SHOW"] },
      },
    });
    if (existingBooking) {
      return NextResponse.json({ error: "Time slot is already taken" }, { status: 409 });
    }

    const services = await prisma.service.findMany({
      where: {
        active: true,
        OR: [{ id: { in: serviceKeys } }, { name: { in: serviceKeys } }],
      },
    });

    if (!services.length) {
      return NextResponse.json({ error: "Selected service was not found" }, { status: 400 });
    }

    let totalPrice = services.reduce((sum: number, s: { price: any }) => sum + Number(s.price), 0);

    let discountAmount = 0;
    if (promoCode) {
      const promoRate = PROMO_CODES[String(promoCode).toUpperCase()];
      if (promoRate) {
        discountAmount = Math.round(totalPrice * promoRate * 100) / 100;
        totalPrice = Math.round((totalPrice - discountAmount) * 100) / 100;
      }
    } else if (discount && Number(discount) > 0) {
      discountAmount = Number(discount);
      totalPrice = Math.round((totalPrice - discountAmount) * 100) / 100;
    }
    if (totalPrice < 0) totalPrice = 0;

    const booking = await prisma.booking.create({
      data: {
        customerName,
        customerPhone,
        customerEmail,
        date: requestedDate,
        time,
        staffId: staffId || null,
        totalPrice,
        discount: discountAmount > 0 ? discountAmount : null,
        promoCode: promoCode || null,
        notes,
        services: { create: services.map((service) => ({ serviceId: service.id })) },
      },
      include: { services: { include: { service: true } }, staff: true },
    });

    await prisma.revenue.create({
      data: { date: requestedDate, amount: totalPrice, category: "SERVICE", discountApplied: discountAmount > 0, bookingId: booking.id },
    });

    return NextResponse.json({ booking });
  } catch (e) {
    return NextResponse.json({ error: "Booking failed" }, { status: 500 });
  }
}

export async function GET() {
  const bookings = await prisma.booking.findMany({
    include: { services: { include: { service: true } }, staff: true },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ bookings });
}
