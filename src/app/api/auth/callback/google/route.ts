import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  createAppSessionFromGooglePayload,
  exchangeGoogleCode,
  googleCalendarCallbackHtml,
  googleCallbackHtml,
  verifyGoogleIdToken,
  verifyGoogleState,
} from "@/lib/google-auth";
import { ensureGoogleCalendarWatch } from "@/lib/google-calendar";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function publicBase(req: NextRequest) {
  const configured = process.env.PUBLIC_APP_URL || process.env.NEXTAUTH_URL || process.env.FRONTEND_URL;
  if (configured) return configured.replace(/\/$/, "");

  const forwardedOrigin = req.headers.get("x-forwarded-origin");
  if (forwardedOrigin && !forwardedOrigin.includes("0.0.0.0")) return forwardedOrigin.replace(/\/$/, "");

  const forwardedHost = req.headers.get("x-forwarded-host");
  if (forwardedHost && !forwardedHost.startsWith("0.0.0.0")) {
    const proto = req.headers.get("x-forwarded-proto") || "https";
    return `${proto}://${forwardedHost}`.replace(/\/$/, "");
  }

  return req.nextUrl.origin.replace(/\/$/, "");
}

function loginErrorRedirect(req: NextRequest, message: string) {
  return NextResponse.redirect(new URL(`/login?google_error=${encodeURIComponent(message)}`, publicBase(req)));
}

export async function GET(req: NextRequest) {
  const error = req.nextUrl.searchParams.get("error");
  if (error) return loginErrorRedirect(req, error);

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  if (!code || !state) return loginErrorRedirect(req, "missing_code");

  try {
    const { next, calendar, actorUserId } = verifyGoogleState(state);
    const googleToken = await exchangeGoogleCode(code, { calendar });
    const payload = await verifyGoogleIdToken(googleToken.id_token);
    const session = actorUserId
      ? await prisma.user.findUnique({ where: { id: actorUserId }, select: { id: true, email: true, name: true, role: true } })
      : null;
    const { user, token } = session
      ? { user: session, token: null }
      : await createAppSessionFromGooglePayload(payload);

    if (calendar) {
      const staff = await prisma.staff.findFirst({ where: { email: user.email }, select: { id: true } });
      const existing = await (prisma as any).googleCalendarConnection.findUnique({
        where: { userId_calendarId: { userId: user.id, calendarId: "primary" } },
      }).catch(() => null);

      const connection = await (prisma as any).googleCalendarConnection.upsert({
        where: { userId_calendarId: { userId: user.id, calendarId: "primary" } },
        update: {
          email: user.email,
          staffId: staff?.id || null,
          accessToken: googleToken.access_token || existing?.accessToken || null,
          refreshToken: googleToken.refresh_token || existing?.refreshToken || null,
          scope: googleToken.scope || existing?.scope || null,
          calendarId: "primary",
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
        await (prisma as any).calendarSyncLog.create({
          data: {
            direction: "OAUTH",
            status: "FAILED",
            message: err.message.slice(0, 500),
            staffId: staff?.id || null,
          },
        }).catch(() => null);
        throw err;
      });

      await (prisma as any).calendarSyncSetting.upsert({
        where: { id: "default" },
        update: {
          ownerEmail: payload.email || user.email || undefined,
          ownerCalendarId: "primary",
          syncEnabled: true,
          googleSyncEnabled: true,
        },
        create: {
          id: "default",
          ownerEmail: payload.email || user.email || "",
          ownerCalendarId: "primary",
          syncEnabled: true,
          googleSyncEnabled: true,
        },
      }).catch(() => null);

      let watchStatus = "ready";
      let watchError = "";
      try {
        const watch = await ensureGoogleCalendarWatch(prisma as any, connection);
        watchStatus = watch.ok ? (watch.skipped ? "ready" : "connected") : "failed";
        watchError = String(watch.error || watch.reason || "").slice(0, 180);
      } catch (watchErr) {
        watchStatus = "failed";
        watchError = (watchErr instanceof Error ? watchErr.message : String(watchErr)).slice(0, 180);
      }

      return new NextResponse(googleCalendarCallbackHtml(next, {
        google_calendar: "connected",
        google_email: payload.email || user.email,
        google_watch: watchStatus,
        ...(watchError ? { google_watch_error: watchError } : {}),
      }), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    return new NextResponse(googleCallbackHtml(String(token || ""), next), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "google_callback_failed";
    return loginErrorRedirect(req, detail);
  }
}
