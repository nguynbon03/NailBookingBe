import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashVerificationToken } from "@/lib/email-verification";
import { bookingInclude, serializeBooking } from "@/lib/booking-workflow";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function verifyToken(token: string) {
  const tokenHash = hashVerificationToken(token);
  const booking = await prisma.booking.findFirst({
    where: { emailVerificationTokenHash: tokenHash },
    include: bookingInclude,
  });

  if (!booking) return { error: "Verification link is invalid", status: 400 } as const;
  if (booking.emailVerifiedAt) return { booking, alreadyVerified: true } as const;
  if (!booking.emailVerificationExpiresAt || booking.emailVerificationExpiresAt < new Date()) {
    return { error: "Verification link expired. Please make a new booking request or ask the shop to resend verification.", status: 410 } as const;
  }

  const verified = await prisma.$transaction(async (tx) => {
    const updated = await tx.booking.update({
      where: { id: booking.id },
      data: {
        emailVerifiedAt: new Date(),
        emailVerificationTokenHash: null,
        emailVerificationExpiresAt: null,
      },
      include: bookingInclude,
    });
    await tx.notification.create({
      data: {
        audience: "ADMIN",
        bookingId: booking.id,
        type: "CUSTOMER_EMAIL_VERIFIED",
        title: "Customer confirmed by email",
        message: `${booking.customerName} verified ${booking.customerEmail || "their email"}. Admin/manager can now decide whether to confirm the booking.`,
      },
    });
    return updated;
  });

  return { booking: verified, alreadyVerified: false } as const;
}

export async function POST(req: NextRequest) {
  const { token } = await req.json().catch(() => ({}));
  if (!token) return NextResponse.json({ error: "Verification token is required" }, { status: 400 });
  const result = await verifyToken(String(token));
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ booking: serializeBooking(result.booking), alreadyVerified: result.alreadyVerified });
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token) return NextResponse.json({ error: "Verification token is required" }, { status: 400 });
  const result = await verifyToken(token);
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ booking: serializeBooking(result.booking), alreadyVerified: result.alreadyVerified });
}
