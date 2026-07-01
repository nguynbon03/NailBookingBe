import { NextRequest, NextResponse } from "next/server";
import {
  createAppSessionFromGooglePayload,
  googleAuthorizationUrl,
  verifyGoogleIdToken,
} from "@/lib/google-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function googleLoginEnabled() {
  return process.env.GOOGLE_LOGIN_ENABLED === "true" || process.env.NEXT_PUBLIC_GOOGLE_LOGIN_ENABLED === "true";
}

export async function GET(req: NextRequest) {
  const next = req.nextUrl.searchParams.get("next") || "/";
  if (!googleLoginEnabled()) {
    return NextResponse.redirect(new URL(`/login?google_error=${encodeURIComponent("Google sign-in is temporarily disabled. Please use username/email + password.")}&next=${encodeURIComponent(next)}`, req.nextUrl.origin));
  }
  try {
    return NextResponse.redirect(googleAuthorizationUrl(next));
  } catch {
    return NextResponse.redirect(new URL(`/login?google_error=${encodeURIComponent("Google login is not configured. Please use username/email + password.")}&next=${encodeURIComponent(next)}`, req.nextUrl.origin));
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
