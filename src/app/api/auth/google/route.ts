import { NextRequest, NextResponse } from "next/server";
import {
  createAppSessionFromGooglePayload,
  googleAuthorizationUrl,
  verifyGoogleIdToken,
} from "@/lib/google-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const next = req.nextUrl.searchParams.get("next") || "/";
    return NextResponse.redirect(googleAuthorizationUrl(next));
  } catch {
    return NextResponse.json({ error: "Google login is not configured" }, { status: 503 });
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
