import { NextRequest, NextResponse } from "next/server";
import { BookingStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAuthUser, isAdminRole } from "@/lib/auth";
import { bookingInclude, serializeBooking, updateBookingStatusWithRevenue } from "@/lib/booking-workflow";
import { availableCapacityAt, isStaffAvailableAndFree, availableStaffIdsAt } from "@/lib/availability";
import { notifyBookingCreated, notifyBookingStatusChanged } from "@/lib/notifications";
import { deliverPendingCustomerNotifications } from "@/lib/customer-notifications";
import { createVerificationToken, isValidEmail, normalizeEmail } from "@/lib/email-verification";
import { bookingReference, paymentTransferUrl } from "@/lib/payment-locks";
import { assessBookingProtection } from "@/lib/booking-protection";
import { syncBookingToCalCom, cancelCalComBooking } from "@/lib/calcom";
import { syncBookingToGoogleCalendar, cancelGoogleCalendarBooking } from "@/lib/google-calendar";

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
    if (!authUser) {
      return NextResponse.json({ error: "Please sign in before booking online" }, { status: 401 });
    }
    if (!authUser.emailVerifiedAt && isValidEmail(String(authUser.email || ""))) {
      return NextResponse.json({ error: "Please verify your account email before booking online" }, { status: 403 });
    }

    if (!authUser.phoneVerifiedAt) {
      return NextResponse.json({ error: "Please verify your phone number via WhatsApp or SMS OTP before booking. This is required to prevent spam and fake bookings." }, { status: 403 });
    }

    const body = await req.json();
    const numPeople = Math.max(1, Math.min(10, parseInt(body.numPeople || "1", 10) || 1));
    const { customerName, customerPhone, customerEmail, serviceIds, staffId, promoCode, notes } = body;
    const date = body.date;
    const time = body.time;

    const name = String(customerName || authUser.name || "").trim();
    const phone = String(customerPhone || authUser.phone || "").trim();
    const email = normalizeEmail(customerEmail || authUser.email || "");
    const accountEmail = normalizeEmail(authUser.email);

    if (!name || !phone || !email || !date || !time) {
      return NextResponse.json({ error: "Missing required booking fields" }, { status: 400 });
    }

    const accountUsesEmail = isValidEmail(accountEmail);
    if (accountUsesEmail && !isValidEmail(email)) {
      return NextResponse.json({ error: "Please enter a valid email address" }, { status: 400 });
    }
    if (email !== accountEmail) {
      return NextResponse.json({ error: accountUsesEmail ? "Booking email must match the signed-in account email" : "Booking account must match the signed-in account" }, { status: 403 });
    }

    const serviceKeys = normalizeServiceInputs(serviceIds);
    if (!serviceKeys.length) {
      return NextResponse.json({ error: "At least one service is required" }, { status: 400 });
    }

    if (staffId) {
      const staff = await prisma.staff.findFirst({ where: { id: String(staffId), active: true, role: { notIn: ["ADMIN", "MANAGER"] } } });
      if (!staff) return NextResponse.json({ error: "Selected staff was not found or is not bookable" }, { status: 400 });
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

    const availableCapacity = await availableCapacityAt(prisma, requestedDate, time, totalDuration, staffId ? String(staffId) : null);
    if (availableCapacity < numPeople) {
      return NextResponse.json({
        error: `Only ${availableCapacity} staff-capacity slot${availableCapacity === 1 ? "" : "s"} left for this time. Please reduce the number of people or choose another time.`,
        availableCapacity,
      }, { status: 409 });
    }

    let basePrice = services.reduce((sum: number, s: { price: unknown }) => sum + Number(s.price), 0);
    let totalPrice = Math.round(basePrice * numPeople * 100) / 100;
    let discountAmount = 0;
    let appliedPromoCode: string | null = null;
    const activePromo = await getActivePromo(promoCode);
    if (activePromo) {
      discountAmount = Math.round(totalPrice * (activePromo.discountPercent / 100) * 100) / 100;
      totalPrice = Math.round((totalPrice - discountAmount) * 100) / 100;
      appliedPromoCode = activePromo.code;
    }
    if (totalPrice < 0) totalPrice = 0;

    const protection = await assessBookingProtection(prisma, req, {
      authUser,
      email,
      phone,
      requestedDate,
      totalPrice,
    });
    const transfer = protection.depositRequired ? createVerificationToken(7 * 24 * 60) : null;
    const transferUrl = transfer ? paymentTransferUrl(transfer.token) : null;

    const booking = await prisma.$transaction(async (tx) => {
      const created = await tx.booking.create({
        data: {
          userId: authUser.id,
          customerName: name,
          customerPhone: phone,
          customerEmail: email,
          date: requestedDate,
          time,
          staffId: null,
          requestedStaffId: staffId ? String(staffId) : null,
          status: "PENDING",
          totalPrice,
          discount: discountAmount > 0 ? discountAmount : null,
          promoCode: appliedPromoCode,
          emailVerifiedAt: new Date(),
          paymentTransferTokenHash: transfer?.tokenHash || null,
          paymentTransferExpiresAt: transfer?.expiresAt || null,
          paymentReference: null,
          sourceIp: protection.sourceIp,
          userAgent: protection.userAgent,
          depositRequired: protection.depositRequired,
          depositAmount: protection.depositRequired ? protection.depositAmount : null,
          depositModeSnapshot: protection.depositMode,
          notes: notes ? String(notes) : null,
          numPeople: numPeople,
          services: { create: services.map((service) => ({ serviceId: service.id })) },
        },
        include: bookingInclude,
      });
      const withRef = await tx.booking.update({
        where: { id: created.id },
        data: { paymentReference: bookingReference(created.id) },
        include: bookingInclude,
      });
      await notifyBookingCreated(tx, withRef, transferUrl || undefined, protection.reasons);
      return withRef;
    });

    const notificationDelivery = await deliverPendingCustomerNotifications(prisma, booking.id);
    return NextResponse.json({
      booking: serializeBooking(booking),
      verification: {
        status: protection.depositRequired ? "DEPOSIT_REQUIRED" : "AWAITING_STAFF_ACCEPTANCE",
        reference: booking.paymentReference || bookingReference(booking.id),
        expiresAt: booking.paymentTransferExpiresAt,
        depositRequired: protection.depositRequired,
        depositAmount: protection.depositAmount,
        depositReasons: protection.reasons,
        instructions: protection.depositRequired
          ? "This booking needs a deposit before staff assignment. Open the secure deposit link sent by email and use the booking reference when transferring."
          : "Your booking request has been sent to staff. A staff member will accept/confirm it if they can take this slot.",
      },
      notificationDelivery,
    });
  } catch (e: any) {
    const message = e instanceof Error && e.message ? e.message : "Booking failed";
    const status = message.startsWith("Booking blocked") || message.startsWith("Booking limit") ? 429 : 500;
    return NextResponse.json({ error: message }, { status });
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
    orderBy: searchParams.get("date")
      ? [{ date: "asc" }, { time: "asc" }, { createdAt: "desc" }]
      : [{ createdAt: "desc" }, { date: "asc" }, { time: "asc" }],
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

  const target = await prisma.booking.findUnique({
    where: { id: String(id) },
    include: { services: { include: { service: true } }, staff: true, requestedStaff: true },
  });
  if (!target) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  if (status === "CONFIRMED" && !target.emailVerifiedAt) {
    return NextResponse.json({ error: "Customer account email is not verified yet." }, { status: 409 });
  }

  const totalDuration = (target.services || []).reduce((sum: number, item: any) => sum + Number(item.service?.duration || 0), 0) || 30;
  let confirmedStaffId: string | null | undefined = staffId === undefined ? undefined : (staffId || null);
  if (status === "CONFIRMED") {
    confirmedStaffId = confirmedStaffId || target.staffId || target.requestedStaffId || target.paymentHoldStaffId || null;
    if (confirmedStaffId) {
      const ok = await isStaffAvailableAndFree(prisma, confirmedStaffId, target.date, target.time, totalDuration, target.id);
      if (!ok) {
        return NextResponse.json({ error: "The selected staff is no longer available for this slot. Reassign before confirming." }, { status: 409 });
      }
    } else {
      const free = await availableStaffIdsAt(prisma, target.date, target.time, totalDuration);
      if (!free.length) return NextResponse.json({ error: "No staff is available for this slot" }, { status: 409 });
      confirmedStaffId = free[0];
    }
  }

  const booking = await prisma.$transaction(async (tx) => {
    const extraData: Record<string, unknown> = {};
    if (staffId !== undefined) extraData.staffId = staffId || null;
    if (status === "CONFIRMED") {
      extraData.staffId = confirmedStaffId || null;
      extraData.paymentHoldStaffId = null;
      extraData.paymentConfirmedAt = target.depositRequired ? (target.paymentConfirmedAt || new Date()) : null;
      extraData.paymentConfirmedBy = target.depositRequired ? (authUser.name || authUser.email) : null;
      extraData.paymentReference = target.paymentReference || bookingReference(target.id);
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
  const calcomSync = status === "CANCELLED" ? await cancelCalComBooking(prisma, booking as any) : await syncBookingToCalCom(prisma, booking as any);
  const googleSync = status === "CANCELLED" ? await cancelGoogleCalendarBooking(prisma, booking as any) : await syncBookingToGoogleCalendar(prisma, booking as any);
  return NextResponse.json({ booking: serializeBooking(booking), calcomSync, googleSync });
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
