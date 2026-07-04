import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, isAdminRole } from "@/lib/auth";
import { calcomConfigured } from "@/lib/calcom";
import { defaultOwnerEmail, defaultOwnerPhone } from "@/lib/reporting";
import { googleAuthorizationUrl, googleCalendarRedirectUri, googleClientId, googleClientSecret } from "@/lib/google-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type SettingUpdate = {
  syncEnabled?: boolean;
  googleSyncEnabled?: boolean;
  calcomSyncEnabled?: boolean;
  dailyExportEnabled?: boolean;
  autoDailyReportEnabled?: boolean;
  dailyReportEmailEnabled?: boolean;
  dailyReportSmsEnabled?: boolean;
  dailyReportIncludePdf?: boolean;
  dailyReportTime?: string;
  ownerEmail?: string | null;
  ownerPhone?: string | null;
  ownerCalendarId?: string;
  provider?: string;
};

function publicBase(req: NextRequest) {
  return (process.env.PUBLIC_APP_URL || process.env.NEXTAUTH_URL || process.env.FRONTEND_URL || "https://bookingnail.overpowers.agency").replace(/\/$/, "");
}

async function requireAdmin(req: NextRequest) {
  const authUser = await getAuthUser(req);
  return authUser && isAdminRole(authUser.role) ? authUser : null;
}

async function ensureSettings() {
  return (prisma as any).calendarSyncSetting.upsert({
    where: { id: "default" },
    update: {},
    create: {
      id: "default",
      ownerEmail: defaultOwnerEmail() || null,
      ownerPhone: defaultOwnerPhone() || null,
      ownerCalendarId: "primary",
      provider: "GOOGLE_CALENDAR",
    },
  });
}

function cleanTime(value: unknown) {
  const text = String(value || "08:30").trim();
  return /^\d{2}:\d{2}$/.test(text) ? text : "08:30";
}

function cleanNullable(value: unknown) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function envStatus(req: NextRequest, authUser?: { id: string; role: string }) {
  const base = publicBase(req);
  const googleConfigured = Boolean(googleClientId() && googleClientSecret());
  const smsConfigured = Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && (process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_FROM));
  const emailConfigured = Boolean((process.env.SMTP_HOST && (process.env.SMTP_FROM || process.env.FROM_EMAIL)) || (process.env.RESEND_API_KEY && process.env.FROM_EMAIL));
  let connectUrl = `${base}/api/auth/google?calendar=1&next=${encodeURIComponent("/admin/google-sync")}`;
  if (googleConfigured && authUser?.id) {
    try {
      connectUrl = googleAuthorizationUrl("/admin/google-sync", { calendar: true, actorUserId: authUser.id, actorRole: authUser.role }).toString();
    } catch {
      connectUrl = `${base}/api/auth/google?calendar=1&next=${encodeURIComponent("/admin/google-sync")}`;
    }
  }
  return {
    google: {
      configured: googleConfigured,
      connectUrl,
      redirectUri: googleCalendarRedirectUri(),
    },
    calcom: {
      configured: calcomConfigured(),
    },
    reports: {
      cronSecretConfigured: Boolean(process.env.REPORT_CRON_SECRET || process.env.CRON_SECRET),
      emailConfigured,
      smsConfigured,
      dailyPdfUrl: `${base}/api/admin/reports/revenue/export?period=day&format=pdf`,
      dailyCsvUrl: `${base}/api/admin/reports/revenue/export?period=day&format=csv`,
    },
    exports: {
      icsUrl: `${base}/api/staff/schedule/export?format=ics`,
      adminCalendarUrl: `${base}/admin/calendar`,
    },
  };
}

export async function GET(req: NextRequest) {
  const authUser = await requireAdmin(req);
  if (!authUser) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const [settings, connections, logs, reportLogs] = await Promise.all([
    ensureSettings(),
    (prisma as any).googleCalendarConnection.findMany({
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: { id: true, email: true, staffId: true, calendarId: true, syncEnabled: true, lastSyncAt: true, createdAt: true, updatedAt: true },
    }).catch(() => []),
    (prisma as any).calendarSyncLog.findMany({ orderBy: { createdAt: "desc" }, take: 20 }).catch(() => []),
    (prisma as any).reportDeliveryLog.findMany({ orderBy: { createdAt: "desc" }, take: 12 }).catch(() => []),
  ]);

  return NextResponse.json({ settings, env: envStatus(req, authUser), connections, logs, reportLogs });
}

export async function PUT(req: NextRequest) {
  const authUser = await requireAdmin(req);
  if (!authUser) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const data: SettingUpdate = {};
  for (const key of ["syncEnabled", "googleSyncEnabled", "calcomSyncEnabled", "dailyExportEnabled", "autoDailyReportEnabled", "dailyReportEmailEnabled", "dailyReportSmsEnabled", "dailyReportIncludePdf"] as const) {
    if (body[key] !== undefined) data[key] = Boolean(body[key]);
  }
  if (body.dailyReportTime !== undefined) data.dailyReportTime = cleanTime(body.dailyReportTime);
  if (body.ownerEmail !== undefined) data.ownerEmail = cleanNullable(body.ownerEmail);
  if (body.ownerPhone !== undefined) data.ownerPhone = cleanNullable(body.ownerPhone);
  if (body.ownerCalendarId !== undefined) data.ownerCalendarId = String(body.ownerCalendarId || "primary").trim() || "primary";
  if (body.provider !== undefined) data.provider = String(body.provider || "GOOGLE_CALENDAR").trim() || "GOOGLE_CALENDAR";

  const settings = await (prisma as any).calendarSyncSetting.upsert({
    where: { id: "default" },
    update: data,
    create: { id: "default", ...data },
  });

  await (prisma as any).calendarSyncLog.create({
    data: {
      direction: "SETTINGS",
      status: "UPDATED",
      message: `${authUser.email} updated calendar/report automation settings`,
    },
  }).catch(() => null);

  return NextResponse.json({ settings, env: envStatus(req, authUser) });
}
