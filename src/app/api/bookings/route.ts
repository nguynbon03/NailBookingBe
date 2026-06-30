import { NextRequest, NextResponse } from "next/server";
import { BookingStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAuthUser, isAdminRole } from "@/lib/auth";
import { bookingInclude, serializeBooking, updateBookingStatusWithRevenue } from "@/lib/booking-workflow";
import { hasAnyAvailableStaff, isStaffAvailableAndFree } from "@/lib/availability";
import { notifyBookingCreated, notifyBookingStatusChanged } from "@/lib/notifications";
import { deliverPendingCustomerNotifications } from "@/lib/customer-notifications";
import { bookingVerificationUrl, createVerificationToken, isValidEmail, normalizeEmail } from "@/lib/email-verification";

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

function bookingReference(id: string) {
  return `NL-${id.slice(-8).toUpperCase()}`;
}

function buildVerificationInfo(booking: { id: string; emailVerificationExpiresAt?: Date | null }) {
  return {
    status: "AWAITING_EMAIL_VERIFICATION",
    reference: bookingReference(booking.id),
    expiresAt: booking.emailVerificationExpiresAt || null,
    instructions: "Please open the verification email and click the secure link. Staff will not see this booking until your email is verified and the shop/admin confirms it.",
  };
}

const CANCELLATION_REASONS = new Set([
  "Shop have Problem",
  "Staff have problem",
  "Shop is too busy",
  "No Reason",
]);

function normalizeCancellationReason(value: unknown) {
  const reason = String(value || "").trim().replace(/\s+/g, " ").slice(0, 240);
  if (!reason || reason === "Other") return "No Reason";
  if (CANCELLATION_REASONS.has(reason)) return reason;
  return reason;
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
    const email = normalizeEmail(customerEmail || authUser?.email || "");

    if (!name || !phone || !email || !date || !time) {
      return NextResponse.json({ error: "Missing required booking fields" }, { status: 400 });
    }

    if (!isValidEmail(email)) {
      return NextResponse.json({ error: "Please enter a valid email address" }, { status: 400 });
    }

    const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true, emailVerifiedAt: true } });
    if (!existingUser) {
      return NextResponse.json({ error: "Please register this email before booking online. We only send verification links to registered emails to prevent fake bookings." }, { status: 400 });
    }
    if (!existingUser.emailVerifiedAt) {
      return NextResponse.json({ error: "Please verify your account email before booking online. Check your inbox for the account verification link." }, { status: 403 });
    }
    if (authUser && normalizeEmail(authUser.email) !== email) {
      return NextResponse.json({ error: "Booking email must match the logged-in account email" }, { status: 403 });
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
        status: "CONFIRMED",
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

    const verification = createVerificationToken();
    const verificationUrl = bookingVerificationUrl(verification.token);

    const booking = await prisma.$transaction(async (tx) => {
      const created = await tx.booking.create({
        data: {
          userId: existingUser.id,
          customerName: name,
          customerPhone: phone,
          customerEmail: email || null,
          date: requestedDate,
          time,
          staffId: null,
          status: "PENDING",
          totalPrice,
          discount: discountAmount > 0 ? discountAmount : null,
          promoCode: appliedPromoCode,
          emailVerificationTokenHash: verification.tokenHash,
          emailVerificationExpiresAt: verification.expiresAt,
          emailVerificationSentAt: new Date(),
          notes: notes ? String(notes) : null,
          services: { create: services.map((service) => ({ serviceId: service.id })) },
        },
        include: bookingInclude,
      });
      await notifyBookingCreated(tx, created, verificationUrl);
      return created;
    });

    await deliverPendingCustomerNotifications(prisma, booking.id);
    return NextResponse.json({ booking: serializeBooking(booking), verification: buildVerificationInfo(booking) });
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
    where: {
      ...(mine ? { userId: authUser!.id } : {}),
      ...(searchParams.get("includeArchived") === "1" ? {} : { archivedAt: null }),
      ...(searchParams.get("date") ? {
        date: {
          gte: new Date(`${searchParams.get("date")}T00:00:00.000Z`),
          lt: new Date(`${searchParams.get("date")}T23:59:59.999Z`),
        },
      } : {}),
      ...(searchParams.get("status") ? { status: searchParams.get("status") as BookingStatus } : {}),
    },
    include: bookingInclude,
    orderBy: [{ date: "asc" }, { time: "asc" }, { createdAt: "desc" }],
  });
  return NextResponse.json({ bookings: bookings.map(serializeBooking) });
}

export async function PUT(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || !isAdminRole(authUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id, status, staffId, cancellationReason } = await req.json().catch(() => ({}));
  const allowed = new Set(["PENDING", "CONFIRMED", "COMPLETED", "CANCELLED", "NO_SHOW"]);
  if (!id || !allowed.has(status)) {
    return NextResponse.json({ error: "Invalid booking status" }, { status: 400 });
  }

  const target = await prisma.booking.findUnique({ where: { id: String(id) }, select: { id: true, status: true, emailVerifiedAt: true, paymentConfirmedAt: true } });
  if (!target) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  if (status === "CONFIRMED" && !target.emailVerifiedAt) {
    return NextResponse.json({ error: "Customer email is not verified yet. Ask the customer to click the verification email before confirming payment." }, { status: 409 });
  }

  const booking = await prisma.$transaction(async (tx) => {
    const extraData: Record<string, unknown> = {};
    if (staffId !== undefined) extraData.staffId = staffId || null;
    if (status === "CONFIRMED") {
      extraData.paymentConfirmedAt = target.paymentConfirmedAt || new Date();
      extraData.paymentConfirmedBy = authUser.name || authUser.email;
    }
    if (status === "PENDING") {
      extraData.paymentConfirmedAt = null;
      extraData.paymentConfirmedBy = null;
      extraData.staffId = null;
    }
    if (status === "CANCELLED") extraData.cancellationReason = normalizeCancellationReason(cancellationReason);
    const updated = await updateBookingStatusWithRevenue(tx, String(id), status as BookingStatus, extraData);
    await notifyBookingStatusChanged(tx, updated, authUser.name);
    return updated;
  });

  await deliverPendingCustomerNotifications(prisma, booking.id);
  return NextResponse.json({ booking: serializeBooking(booking) });
}

export async function DELETE(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || !isAdminRole(authUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id, hardDelete } = await req.json().catch(() => ({}));
  if (!id) return NextResponse.json({ error: "Booking id is required" }, { status: 400 });

  if (hardDelete) {
    if (authUser.role !== "ADMIN") return NextResponse.json({ error: "Only ADMIN can permanently delete booking records" }, { status: 403 });
    await prisma.booking.delete({ where: { id: String(id) } });
    return NextResponse.json({ success: true, deleted: true });
  }

  const booking = await prisma.booking.update({
    where: { id: String(id) },
    data: { archivedAt: new Date() },
    include: bookingInclude,
  });
  return NextResponse.json({ booking: serializeBooking(booking), archived: true });
}
