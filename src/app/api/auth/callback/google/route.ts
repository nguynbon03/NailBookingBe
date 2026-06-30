import { NextRequest, NextResponse } from "next/server";
import {
  createAppSessionFromGooglePayload,
  exchangeGoogleCode,
  googleCallbackHtml,
  verifyGoogleIdToken,
  verifyGoogleState,
} from "@/lib/google-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const error = req.nextUrl.searchParams.get("error");
  if (error) return NextResponse.redirect(new URL(`/login?google_error=${encodeURIComponent(error)}`, req.nextUrl.origin));

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  if (!code || !state) return NextResponse.redirect(new URL("/login?google_error=missing_code", req.nextUrl.origin));

  try {
    const { next } = verifyGoogleState(state);
    const idToken = await exchangeGoogleCode(code);
    const payload = await verifyGoogleIdToken(idToken);
    const { token } = await createAppSessionFromGooglePayload(payload);
    return new NextResponse(googleCallbackHtml(token, next), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "google_callback_failed";
    return NextResponse.redirect(new URL(`/login?google_error=${encodeURIComponent(detail)}`, req.nextUrl.origin));
  }
}
