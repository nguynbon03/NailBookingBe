import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { deliverPendingCustomerNotifications, queueDirectCustomerNotification } from "@/lib/customer-notifications";
import { buildRevenueReport, dailySmsText, defaultOwnerEmail, defaultOwnerPhone, revenueReportPdf, sendReportEmail } from "@/lib/reporting";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function authorize(req: NextRequest) {
  const configured = process.env.REPORT_CRON_SECRET || process.env.CRON_SECRET || "";
  if (!configured) return { ok: false, status: 503, error: "REPORT_CRON_SECRET is not configured" };
  const supplied = req.headers.get("x-report-secret") || req.nextUrl.searchParams.get("secret") || "";
  if (supplied !== configured) return { ok: false, status: 401, error: "Unauthorized" };
  return { ok: true, status: 200, error: "" };
}

function statusFromDelivery(delivery: any) {
  if (delivery?.sent > 0) return "SENT";
  if (delivery?.failed > 0) return "FAILED";
  if (delivery?.skipped > 0) return "SKIPPED";
  return "PENDING";
}

function providerForEmail(delivery: any) {
  return delivery?.provider || (process.env.RESEND_API_KEY ? "resend" : process.env.SMTP_HOST ? "smtp" : "none");
}

function londonNow(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date).map((part) => [part.type, part.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour || 0) * 60 + Number(parts.minute || 0),
  };
}

function dueForDailyRun(config: any, now = new Date()) {
  const current = londonNow(now);
  const [hour, minute] = String(config?.dailyReportTime || "08:30").split(":").map((item) => Number(item));
  const targetMinutes = (Number.isFinite(hour) ? hour : 8) * 60 + (Number.isFinite(minute) ? minute : 30);
  if (current.minutes < targetMinutes) return { due: false, reason: "Scheduled time has not arrived yet", reportDate: current.date };
  if (config?.lastDailyReportAt) {
    const last = londonNow(new Date(config.lastDailyReportAt));
    if (last.date === current.date) return { due: false, reason: "Daily report already sent today", reportDate: current.date };
  }
  return { due: true, reason: "Due", reportDate: current.date };
}

async function settings() {
  return (prisma as any).calendarSyncSetting.upsert({
    where: { id: "default" },
    update: {},
    create: { id: "default", ownerEmail: defaultOwnerEmail() || null, ownerPhone: defaultOwnerPhone() || null },
  }).catch(() => null);
}

export async function GET(req: NextRequest) {
  return POST(req);
}

export async function POST(req: NextRequest) {
  const auth = authorize(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const requestedDate = req.nextUrl.searchParams.get("date");
  const force = req.nextUrl.searchParams.get("force") === "1";
  const config = await settings();
  if (!force && config && (!config.autoDailyReportEnabled || !config.dailyExportEnabled)) {
    return NextResponse.json({ ok: true, skipped: true, reason: "Auto daily report is disabled", settings: config });
  }
  const due = dueForDailyRun(config);
  if (!force && !due.due) {
    return NextResponse.json({ ok: true, skipped: true, reason: due.reason, reportDate: due.reportDate });
  }

  const phone = req.nextUrl.searchParams.get("phone") || config?.ownerPhone || (force ? defaultOwnerPhone() : "");
  const email = req.nextUrl.searchParams.get("email") || config?.ownerEmail || (force ? defaultOwnerEmail() : "");
  const report = await buildRevenueReport(prisma, "day", requestedDate || due.reportDate);
  const message = dailySmsText(report);

  let smsDelivery: any = null;
  let smsStatus = "SKIPPED";
  if ((force || config?.dailyReportSmsEnabled) && phone) {
    await queueDirectCustomerNotification(prisma, {
      recipient: phone,
      channel: "SMS",
      event: "daily_revenue_report",
      subject: "Daily revenue report",
      message,
      bookingId: null,
    });
    smsDelivery = await deliverPendingCustomerNotifications(prisma, null, "daily_revenue_report", phone);
    smsStatus = statusFromDelivery(smsDelivery);
    await (prisma as any).reportDeliveryLog.create({
      data: {
        reportType: "daily_revenue_report",
        period: "day",
        periodStart: report.range.start,
        periodEnd: report.range.end,
        channel: "SMS",
        recipient: phone,
        status: smsStatus,
        provider: smsDelivery?.sms?.provider || "twilio",
        providerMessageId: smsDelivery?.sms?.providerMessageId || null,
        error: smsDelivery?.sms?.error || null,
        sentAt: smsStatus === "SENT" ? new Date() : null,
      },
    }).catch(() => null);
  }

  let emailDelivery: any = null;
  let emailStatus = "SKIPPED";
  if ((force || config?.dailyReportEmailEnabled) && email) {
    try {
      const pdf = revenueReportPdf(report);
      const filename = `nail-lounge-revenue-day-${report.range.label.replace(/[^0-9A-Za-z-]+/g, "_")}.pdf`;
      emailDelivery = await sendReportEmail({
        to: email,
        subject: `Nail Lounge daily revenue report ${report.range.label}`,
        text: `${message}\n\nAttached is the PDF export for confirmed/completed revenue only.`,
        pdf,
        filename,
      });
      emailStatus = "SENT";
    } catch (error) {
      emailDelivery = { error: error instanceof Error ? error.message : String(error) };
      emailStatus = "FAILED";
    }
    await (prisma as any).reportDeliveryLog.create({
      data: {
        reportType: "daily_revenue_report_pdf",
        period: "day",
        periodStart: report.range.start,
        periodEnd: report.range.end,
        channel: "EMAIL",
        recipient: email,
        status: emailStatus,
        provider: providerForEmail(emailDelivery),
        providerMessageId: emailDelivery?.messageId || null,
        error: emailDelivery?.error || null,
        sentAt: emailStatus === "SENT" ? new Date() : null,
      },
    }).catch(() => null);
  }

  await (prisma as any).calendarSyncSetting.update({ where: { id: "default" }, data: { lastDailyReportAt: new Date(), lastExportAt: new Date() } }).catch(() => null);
  await prisma.notification.create({
    data: {
      audience: "ADMIN",
      type: "DAILY_REVENUE_REPORT_SENT",
      title: smsStatus === "SENT" || emailStatus === "SENT" ? "Daily revenue report sent" : "Daily revenue report attempted",
      message: `Daily revenue report for ${report.range.label}. SMS: ${smsStatus}${smsDelivery?.sms?.error ? ` (${smsDelivery.sms.error})` : ""}. Email: ${emailStatus}${emailDelivery?.error ? ` (${emailDelivery.error})` : ""}. Revenue: ${message}`,
    },
  }).catch(() => null);

  return NextResponse.json({
    ok: smsStatus === "SENT" || emailStatus === "SENT",
    status: { sms: smsStatus, email: emailStatus },
    recipients: { phone, email },
    message,
    delivery: { sms: smsDelivery, email: emailDelivery },
    range: report.range,
  });
}
