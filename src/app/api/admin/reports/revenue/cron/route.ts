import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { deliverPendingCustomerNotifications, queueDirectCustomerNotification } from "@/lib/customer-notifications";
import { buildRevenueReport, dailySmsText, defaultOwnerPhone } from "@/lib/reporting";

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
  if (delivery?.skipped > 0) return "SKIPPED";
  if (delivery?.failed > 0) return "FAILED";
  return "PENDING";
}

export async function GET(req: NextRequest) {
  return POST(req);
}

export async function POST(req: NextRequest) {
  const auth = authorize(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const date = req.nextUrl.searchParams.get("date");
  const phone = req.nextUrl.searchParams.get("phone") || defaultOwnerPhone();
  if (!phone) return NextResponse.json({ error: "Owner phone is required" }, { status: 400 });

  const report = await buildRevenueReport(prisma, "day", date);
  const message = dailySmsText(report);

  await queueDirectCustomerNotification(prisma, {
    recipient: phone,
    channel: "SMS",
    event: "daily_revenue_report",
    subject: "Daily revenue report",
    message,
    bookingId: null,
  });
  const delivery = await deliverPendingCustomerNotifications(prisma, null, "daily_revenue_report", phone);
  const status = statusFromDelivery(delivery);

  await (prisma as any).reportDeliveryLog.create({
    data: {
      reportType: "daily_revenue_report",
      period: "day",
      periodStart: report.range.start,
      periodEnd: report.range.end,
      channel: "SMS",
      recipient: phone,
      status,
      provider: delivery?.sms?.provider || "twilio",
      providerMessageId: delivery?.sms?.providerMessageId || null,
      error: delivery?.sms?.error || null,
      sentAt: status === "SENT" ? new Date() : null,
    },
  }).catch(() => null);

  await prisma.notification.create({
    data: {
      audience: "ADMIN",
      type: "DAILY_REVENUE_REPORT_SENT",
      title: status === "SENT" ? "Daily revenue SMS sent" : "Daily revenue SMS not sent",
      message: status === "SENT"
        ? `Daily revenue SMS sent to owner for ${report.range.label}: ${message}`
        : `Daily revenue SMS attempted for ${report.range.label} but status is ${status}. ${delivery?.sms?.error || "Check SMS provider configuration."}`,
    },
  }).catch(() => null);

  return NextResponse.json({ ok: status === "SENT", status, recipient: phone, message, delivery, range: report.range });
}
