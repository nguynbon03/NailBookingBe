import { NextRequest, NextResponse } from "next/server";
import {
  createAppSessionFromGooglePayload,
  googleAuthorizationUrl,
  googleClientId,
  googleClientSecret,
  verifyGoogleIdToken,
} from "@/lib/google-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function loginRedirect(req: NextRequest, next: string, message: string) {
  const base = process.env.PUBLIC_APP_URL || process.env.NEXTAUTH_URL || req.headers.get("x-forwarded-origin") || req.nextUrl.origin;
  return NextResponse.redirect(new URL(`/login?google_error=${encodeURIComponent(message)}&next=${encodeURIComponent(next)}`, base));
}

export async function GET(req: NextRequest) {
  const next = req.nextUrl.searchParams.get("next") || "/";
  if (!googleClientId() || !googleClientSecret()) {
    return loginRedirect(req, next, "Google login is not configured. Please use username/email + password.");
  }
  try {
    return NextResponse.redirect(googleAuthorizationUrl(next));
  } catch {
    return loginRedirect(req, next, "Google login is not configured. Please use username/email + password.");
  }
}

export async function POST(req: NextRequest) {
  const { credential } = await req.json().catch(() => ({}));
  if (!credential) return NextResponse.json({ error: "Google credential is required" }, { status: 400 });

  try {
    const payload = await verifyGoogleIdToken(String(credential));
    const session = await createAppSessionFromGooglePayload(payload);
    return NextResponse.json(session);
  } catch {
    return NextResponse.json({ error: "Google login failed" }, { status: 401 });
  }
}
