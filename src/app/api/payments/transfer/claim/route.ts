import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { bookingInclude, serializeBooking } from "@/lib/booking-workflow";
import { hashVerificationToken } from "@/lib/email-verification";
import { bookingReference } from "@/lib/payment-locks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function appendNote(existing: string | null | undefined, line: string) {
  const current = String(existing || "").trim();
  return [current, line].filter(Boolean).join("\n").slice(0, 4000);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const token = String(body.token || "").trim();
  const customerNote = String(body.note || "").trim().replace(/\s+/g, " ").slice(0, 300);
  if (!token) return NextResponse.json({ error: "Transfer token is required" }, { status: 400 });

  const booking = await prisma.booking.findFirst({
    where: { paymentTransferTokenHash: hashVerificationToken(token) },
    include: bookingInclude,
  });

  if (!booking) return NextResponse.json({ error: "Transfer link is invalid" }, { status: 404 });
  if (booking.archivedAt || booking.status === "CANCELLED") {
    return NextResponse.json({ error: "This booking is not payable" }, { status: 409 });
  }
  if (booking.status !== "PENDING") {
    return NextResponse.json({ booking: serializeBooking(booking), alreadyHandled: true });
  }

  const now = new Date();
  if (!booking.paymentHoldStaffId || !booking.paymentHoldExpiresAt || booking.paymentHoldExpiresAt < now) {
    return NextResponse.json({ error: "The staff lock expired. Reopen the secure transfer link before marking the transfer as sent." }, { status: 409 });
  }

  const reference = booking.paymentReference || bookingReference(booking.id);
  const staffName = booking.staff?.name || "locked staff";
  const noteLine = `[Customer transfer submitted ${now.toISOString()}] Ref ${reference}. Staff hold: ${staffName}.${customerNote ? ` Note: ${customerNote}` : ""}`;

  const updated = await prisma.$transaction(async (tx) => {
    const saved = await tx.booking.update({
      where: { id: booking.id },
      data: {
        paymentTransferOpenedAt: booking.paymentTransferOpenedAt || now,
        paymentReference: reference,
        notes: appendNote(booking.notes, noteLine),
      },
      include: bookingInclude,
    });
    await tx.notification.create({
      data: {
        audience: "ADMIN",
        bookingId: booking.id,
        type: "CUSTOMER_TRANSFER_SUBMITTED",
        title: "Customer marked bank transfer as sent",
        message: `${booking.customerName} marked transfer as sent for ${reference}. Held staff: ${staffName}. Check bank account, then confirm payment in Admin to release job to staff.`,
      },
    });
    return saved;
  });

  return NextResponse.json({
    booking: serializeBooking(updated),
    transferSubmitted: true,
    reference,
    message: "Transfer note received. The shop will verify the bank transfer and confirm the booking.",
  });
}
