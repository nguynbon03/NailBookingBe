import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, isAdminRole } from "@/lib/auth";
import { deliverPendingCustomerNotifications, queueDirectCustomerNotification } from "@/lib/customer-notifications";
import { buildRevenueReport, dailySmsText, defaultOwnerEmail, defaultOwnerPhone, revenueReportPdf, sendReportEmail } from "@/lib/reporting";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function requireAdmin(req: NextRequest) {
  const authUser = await getAuthUser(req);
  return authUser && isAdminRole(authUser.role) ? authUser : null;
}

export async function GET(req: NextRequest) {
  const authUser = await requireAdmin(req);
  if (!authUser) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { searchParams } = req.nextUrl;
  const report = await buildRevenueReport(prisma, searchParams.get("period") || "day", searchParams.get("date"));
  return NextResponse.json(report);
}

export async function POST(req: NextRequest) {
  const authUser = await requireAdmin(req);
  if (!authUser) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");
  const period = String(body.period || (action === "sendMonthlyEmail" ? "month" : "day"));
  const date = body.date ? String(body.date) : null;
  const report = await buildRevenueReport(prisma, period, date);

  if (action === "sendDailySms") {
    const recipient = String(body.phone || defaultOwnerPhone()).trim();
    if (!recipient) return NextResponse.json({ error: "Owner phone is required" }, { status: 400 });
    const message = dailySmsText(report);
    await queueDirectCustomerNotification(prisma, {
      recipient,
      channel: "SMS",
      event: "daily_revenue_report",
      subject: "Daily revenue report",
      message,
      bookingId: null,
    });
    const delivery = await deliverPendingCustomerNotifications(prisma, null, "daily_revenue_report", recipient);
    return NextResponse.json({ ok: true, action, recipient, message, delivery });
  }

  if (action === "sendDailyEmail" || action === "sendMonthlyEmail") {
    const to = String(body.email || defaultOwnerEmail()).trim();
    if (!to) return NextResponse.json({ error: "Owner email is required" }, { status: 400 });
    const pdf = revenueReportPdf(report);
    const subject = `Nail Lounge ${period === "day" ? "daily" : "revenue"} report ${report.range.label}`;
    const text = `Attached is the Nail Lounge revenue/bank report for ${report.range.label}.\n\nRevenue: £${Number(report.summary.totalRevenue).toFixed(2)}\nPaid/confirmed bookings: ${report.summary.revenueBookingCount}\nPending: ${report.summary.pendingCount}\nCancelled: ${report.summary.cancelledCount}`;
    const filename = `nail-lounge-revenue-${report.range.period}-${report.range.label.replace(/[^0-9A-Za-z-]+/g, "_")}.pdf`;
    const delivery = await sendReportEmail({ to, subject, text, pdf, filename });
    await (prisma as any).reportDeliveryLog.create({
      data: {
        reportType: period === "day" ? "daily_revenue_report_pdf" : "monthly_revenue_report_pdf",
        period,
        periodStart: report.range.start,
        periodEnd: report.range.end,
        channel: "EMAIL",
        recipient: to,
        status: "SENT",
        provider: delivery?.provider || "email",
        providerMessageId: delivery?.messageId || null,
        sentAt: new Date(),
      },
    }).catch(() => null);
    return NextResponse.json({ ok: true, action, recipient: to, delivery });
  }

  return NextResponse.json({ error: "Unsupported report action" }, { status: 400 });
}
