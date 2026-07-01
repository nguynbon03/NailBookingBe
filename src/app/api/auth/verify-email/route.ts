import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashVerificationToken, normalizeVerificationToken } from "@/lib/email-verification";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function verifyAccount(token: string) {
  const normalizedToken = normalizeVerificationToken(token);
  if (!normalizedToken) return { error: "Verification link is invalid", status: 400 } as const;
  const tokenHash = hashVerificationToken(normalizedToken);
  const user = await prisma.user.findFirst({ where: { emailVerificationTokenHash: tokenHash } });
  if (!user) return { error: "Verification link is invalid", status: 400 } as const;
  if (user.emailVerifiedAt) {
    const verifiedUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { id: true, email: true, name: true, role: true, emailVerifiedAt: true },
    });
    return { user: verifiedUser, alreadyVerified: true } as const;
  }
  if (!user.emailVerificationExpiresAt || user.emailVerificationExpiresAt < new Date()) {
    return { error: "Verification link expired. Please register again or ask the shop to resend verification.", status: 410 } as const;
  }
  const verified = await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerifiedAt: new Date(),
      emailVerificationTokenHash: null,
      emailVerificationExpiresAt: null,
    },
    select: { id: true, email: true, name: true, role: true, emailVerifiedAt: true },
  });
  return { user: verified, alreadyVerified: false } as const;
}

export async function POST(req: NextRequest) {
  const { token } = await req.json().catch(() => ({}));
  if (!token) return NextResponse.json({ error: "Verification token is required" }, { status: 400 });
  const result = await verifyAccount(String(token));
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ user: result.user, alreadyVerified: result.alreadyVerified });
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token) return NextResponse.json({ error: "Verification token is required" }, { status: 400 });
  const result = await verifyAccount(token);
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ user: result.user, alreadyVerified: result.alreadyVerified });
}
