import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, isAdminRole } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function normalizeServiceInputs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((v) => String(v || "").trim()).filter(Boolean)));
}

function serializeBooking(booking: any) {
  return {
    ...booking,
    totalPrice: Number(booking.totalPrice),
    discount: booking.discount == null ? null : Number(booking.discount),
    services: booking.services?.map((item: any) => ({
      ...item,
      service: item.service ? { ...item.service, price: Number(item.service.price) } : item.service,
    })) || [],
  };
}

async function getActivePromo(code: unknown) {
  const normalized = String(code || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!normalized) return null;
  const promoCode = await prisma.promoCode.findUnique({ where: { code: normalized } });
  if (!promoCode || !promoCode.active) return null;

  const now = new Date();
  if (promoCode.startsAt && promoCode.startsAt > now) return null;
  if (promoCode.endsAt && promoCode.endsAt < now) return null;
  if (promoCode.usageLimit !== null && promoCode.usedCount >= promoCode.usageLimit) return null;
  return promoCode;
}

export async function POST(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req);
    const body = await req.json();
    const {
      customerName,
      customerPhone,
      customerEmail,
      serviceIds,
      staffId,
      promoCode,
      notes,
    } = body;
    const date = body.date;
    const time = body.time;

    const name = String(customerName || authUser?.name || "").trim();
    const phone = String(customerPhone || authUser?.phone || "").trim();
    const email = String(customerEmail || authUser?.email || "").trim();

    if (!name || !phone || !date || !time) {
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
    let appliedPromoCode: string | null = null;
    const activePromo = await getActivePromo(promoCode);
    if (activePromo) {
      discountAmount = Math.round(totalPrice * (activePromo.discountPercent / 100) * 100) / 100;
      totalPrice = Math.round((totalPrice - discountAmount) * 100) / 100;
      appliedPromoCode = activePromo.code;
    }
    if (totalPrice < 0) totalPrice = 0;

    let userId = authUser?.id || null;
    if (!userId && email) {
      const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true } }).catch(() => null);
      userId = existingUser?.id || null;
    }

    const booking = await prisma.$transaction(async (tx) => {
      const created = await tx.booking.create({
        data: {
          userId,
          customerName: name,
          customerPhone: phone,
          customerEmail: email || null,
          date: requestedDate,
          time,
          staffId: staffId || null,
          totalPrice,
          discount: discountAmount > 0 ? discountAmount : null,
          promoCode: appliedPromoCode,
          notes: notes ? String(notes) : null,
          services: { create: services.map((service) => ({ serviceId: service.id })) },
        },
        include: { services: { include: { service: true } }, staff: true, user: true },
      });

      await tx.revenue.create({
        data: { date: requestedDate, amount: totalPrice, category: "SERVICE", discountApplied: discountAmount > 0, bookingId: created.id },
      });

      if (activePromo) {
        await tx.promoCode.update({ where: { id: activePromo.id }, data: { usedCount: { increment: 1 } } });
      }

      return created;
    });

    return NextResponse.json({ booking: serializeBooking(booking) });
  } catch (e) {
    return NextResponse.json({ error: "Booking failed" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const authUser = await getAuthUser(req);
  const searchParams = req.nextUrl.searchParams;
  const mine = searchParams.get("mine") === "1";

  if (mine && !authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!mine && authUser && !isAdminRole(authUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const bookings = await prisma.booking.findMany({
    where: mine ? { userId: authUser!.id } : undefined,
    include: { services: { include: { service: true } }, staff: true, user: { select: { id: true, email: true, name: true, role: true } } },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ bookings: bookings.map(serializeBooking) });
}

export async function PUT(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || !isAdminRole(authUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id, status } = await req.json().catch(() => ({}));
  const allowed = new Set(["PENDING", "CONFIRMED", "COMPLETED", "CANCELLED", "NO_SHOW"]);
  if (!id || !allowed.has(status)) {
    return NextResponse.json({ error: "Invalid booking status" }, { status: 400 });
  }

  const booking = await prisma.booking.update({
    where: { id },
    data: { status },
    include: { services: { include: { service: true } }, staff: true, user: { select: { id: true, email: true, name: true, role: true } } },
  });

  return NextResponse.json({ booking: serializeBooking(booking) });
}
