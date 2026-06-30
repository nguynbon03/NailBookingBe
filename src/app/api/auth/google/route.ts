import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { SignJWT } from "jose";
import { OAuth2Client } from "google-auth-library";
import { prisma } from "@/lib/prisma";
import { normalizeEmail } from "@/lib/email-verification";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const secret = new TextEncoder().encode(process.env.NEXTAUTH_SECRET || "secret");

function googleClientId() {
  return process.env.GOOGLE_CLIENT_ID || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "";
}

export async function POST(req: NextRequest) {
  const { credential } = await req.json().catch(() => ({}));
  const clientId = googleClientId();
  if (!clientId) return NextResponse.json({ error: "Google login is not configured" }, { status: 503 });
  if (!credential) return NextResponse.json({ error: "Google credential is required" }, { status: 400 });

  try {
    const client = new OAuth2Client(clientId);
    const ticket = await client.verifyIdToken({ idToken: String(credential), audience: clientId });
    const payload = ticket.getPayload();
    const email = normalizeEmail(payload?.email || "");
    if (!email || !payload?.email_verified) {
      return NextResponse.json({ error: "Google account email must be verified" }, { status: 403 });
    }

    const name = String(payload?.name || email.split("@")[0] || "Google User").trim();
    const avatar = payload?.picture || null;
    const randomPassword = await bcrypt.hash(`google:${payload.sub}:${process.env.NEXTAUTH_SECRET || "secret"}`, 10);

    const user = await prisma.user.upsert({
      where: { email },
      update: { name, avatar, emailVerifiedAt: new Date() },
      create: { email, password: randomPassword, name, avatar, role: "CUSTOMER", emailVerifiedAt: new Date() },
      select: { id: true, email: true, name: true, role: true, phone: true, avatar: true, emailVerifiedAt: true },
    });

    const token = await new SignJWT({ id: user.id, email: user.email, role: user.role })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("7d")
      .sign(secret);

    return NextResponse.json({ user, token });
  } catch {
    return NextResponse.json({ error: "Google login failed" }, { status: 401 });
  }
}
