import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
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
    const { next, calendar } = verifyGoogleState(state);
    const googleToken = await exchangeGoogleCode(code, { calendar });
    const payload = await verifyGoogleIdToken(googleToken.id_token);
    const { user, token } = await createAppSessionFromGooglePayload(payload);
    if (calendar) {
      const staff = await prisma.staff.findFirst({ where: { email: user.email }, select: { id: true } });
      const existing = await (prisma as any).googleCalendarConnection.findUnique({ where: { userId_calendarId: { userId: user.id, calendarId: "primary" } } }).catch(() => null);
      await (prisma as any).googleCalendarConnection.upsert({
        where: { userId_calendarId: { userId: user.id, calendarId: "primary" } },
        update: {
          email: user.email,
          staffId: staff?.id || null,
          accessToken: googleToken.access_token || existing?.accessToken || null,
          refreshToken: googleToken.refresh_token || existing?.refreshToken || null,
          scope: googleToken.scope || existing?.scope || null,
          syncEnabled: true,
        },
        create: {
          userId: user.id,
          staffId: staff?.id || null,
          email: user.email,
          accessToken: googleToken.access_token || null,
          refreshToken: googleToken.refresh_token || null,
          scope: googleToken.scope || null,
          calendarId: "primary",
          syncEnabled: true,
        },
      }).catch(async (err: Error) => {
        await (prisma as any).calendarSyncLog.create({ data: { direction: "OAUTH", status: "FAILED", message: err.message.slice(0, 500), staffId: staff?.id || null } }).catch(() => null);
      });
    }
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
