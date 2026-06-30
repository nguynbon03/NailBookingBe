import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { deliverPendingCustomerNotifications, queueDirectCustomerNotification } from "@/lib/customer-notifications";
import { accountVerificationUrl, createVerificationToken, isValidEmail, normalizeEmail } from "@/lib/email-verification";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = normalizeEmail(body.email);
    const password = String(body.password || "");
    const name = String(body.name || "").trim();
    const phone = body.phone ? String(body.phone).trim() : null;

    if (!name || !email || password.length < 6) {
      return NextResponse.json({ error: "Name, valid email and password with at least 6 characters are required" }, { status: 400 });
    }
    if (!isValidEmail(email)) {
      return NextResponse.json({ error: "Please enter a valid email address" }, { status: 400 });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return NextResponse.json({ error: "Email exists" }, { status: 400 });

    const hashed = await bcrypt.hash(password, 10);
    const verification = createVerificationToken();
    const verificationUrl = accountVerificationUrl(verification.token);

    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          password: hashed,
          name,
          phone,
          emailVerificationTokenHash: verification.tokenHash,
          emailVerificationExpiresAt: verification.expiresAt,
          emailVerificationSentAt: new Date(),
        },
        select: { id: true, email: true, name: true, role: true, emailVerifiedAt: true },
      });
      await queueDirectCustomerNotification(tx, {
        recipient: email,
        event: "account_verification",
        subject: "Verify your Nail Lounge account email",
        message: `Hi ${name}, please verify your email before booking online. Click this secure link within 30 minutes: ${verificationUrl}. If you did not create this account, ignore this email.`,
      });
      return created;
    });

    await deliverPendingCustomerNotifications(prisma, null, "account_verification", email);
    return NextResponse.json({ user, verificationRequired: true });
  } catch {
    return NextResponse.json({ error: "Registration failed" }, { status: 500 });
  }
}
