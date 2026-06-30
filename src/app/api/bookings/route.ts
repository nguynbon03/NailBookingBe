import { NextRequest, NextResponse } from "next/server";
import { BookingStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAuthUser, isAdminRole } from "@/lib/auth";
import { bookingInclude, serializeBooking, updateBookingStatusWithRevenue } from "@/lib/booking-workflow";
import { hasAnyAvailableStaff, isStaffAvailableAndFree } from "@/lib/availability";
import { notifyBookingCreated, notifyBookingStatusChanged } from "@/lib/notifications";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function normalizeServiceInputs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((v) => String(v || "").trim()).filter(Boolean)));
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

function isGmailAddress(email: string) {
  return /^[A-Z0-9._%+-]+@gmail\.com$/i.test(email.trim());
}

function bookingReference(id: string) {
  return `NL-${id.slice(-8).toUpperCase()}`;
}

function buildPaymentInfo(booking: { id: string; totalPrice: unknown }) {
  const configured = Number(process.env.BOOKING_DEPOSIT_AMOUNT || "10");
  const total = Number(booking.totalPrice || 0);
  const depositAmount = Math.max(1, Math.min(Number.isFinite(configured) ? configured : 10, total || configured || 10));
  return {
    status: "AWAITING_PAYMENT",
    currency: "GBP",
    depositAmount,
    reference: bookingReference(booking.id),
    instructions: "Please pay the deposit with this reference. Admin will confirm the booking after payment is received.",
  };
}

export async function POST(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req);
    const body = await req.json();
    const { customerName, customerPhone, customerEmail, serviceIds, staffId, promoCode, notes } = body;
    const date = body.date;
    const time = body.time;

    const name = String(customerName || authUser?.name || "").trim();
    const phone = String(customerPhone || authUser?.phone || "").trim();
    const email = String(customerEmail || authUser?.email || "").trim();

    if (!name || !phone || !email || !date || !time) {
      return NextResponse.json({ error: "Missing required booking fields" }, { status: 400 });
    }

    if (!isGmailAddress(email)) {
      return NextResponse.json({ error: "Please use a real Gmail address to book online" }, { status: 400 });
    }

    const serviceKeys = normalizeServiceInputs(serviceIds);
    if (!serviceKeys.length) {
      return NextResponse.json({ error: "At least one service is required" }, { status: 400 });
    }

    if (staffId) {
      const staff = await prisma.staff.findFirst({ where: { id: String(staffId), active: true } });
      if (!staff) return NextResponse.json({ error: "Selected staff was not found" }, { status: 400 });
    }

    const requestedDate = new Date(date);
    const existingBooking = await prisma.booking.findFirst({
      where: {
        date: requestedDate,
        time,
        ...(staffId ? { staffId: String(staffId) } : {}),
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

    const totalDuration = services.reduce((sum: number, s: { duration: number }) => sum + Number(s.duration || 0), 0) || 30;

    if (staffId) {
      const ok = await isStaffAvailableAndFree(prisma, String(staffId), requestedDate, time, totalDuration);
      if (!ok) return NextResponse.json({ error: "Selected staff is not available at this time" }, { status: 409 });
    } else {
      const ok = await hasAnyAvailableStaff(prisma, requestedDate, time, totalDuration);
      if (!ok) return NextResponse.json({ error: "No staff is available at this time" }, { status: 409 });
    }

    let totalPrice = services.reduce((sum: number, s: { price: unknown }) => sum + Number(s.price), 0);
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
          staffId: staffId ? String(staffId) : null,
          status: "PENDING",
          totalPrice,
          discount: discountAmount > 0 ? discountAmount : null,
          promoCode: appliedPromoCode,
          notes: notes ? String(notes) : null,
          services: { create: services.map((service) => ({ serviceId: service.id })) },
        },
        include: bookingInclude,
      });
      await notifyBookingCreated(tx, created);
      return created;
    });

    return NextResponse.json({ booking: serializeBooking(booking), payment: buildPaymentInfo(booking) });
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

  if (!mine && (!authUser || !isAdminRole(authUser.role))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const bookings = await prisma.booking.findMany({
    where: mine ? { userId: authUser!.id } : undefined,
    include: bookingInclude,
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ bookings: bookings.map(serializeBooking) });
}

export async function PUT(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || !isAdminRole(authUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id, status, staffId } = await req.json().catch(() => ({}));
  const allowed = new Set(["PENDING", "CONFIRMED", "COMPLETED", "CANCELLED", "NO_SHOW"]);
  if (!id || !allowed.has(status)) {
    return NextResponse.json({ error: "Invalid booking status" }, { status: 400 });
  }

  const booking = await prisma.$transaction(async (tx) => {
    const extraData: Record<string, unknown> = {};
    if (staffId !== undefined) extraData.staffId = staffId || null;
    const updated = await updateBookingStatusWithRevenue(tx, String(id), status as BookingStatus, extraData);
    await notifyBookingStatusChanged(tx, updated, authUser.name);
    return updated;
  });

  return NextResponse.json({ booking: serializeBooking(booking) });
}
