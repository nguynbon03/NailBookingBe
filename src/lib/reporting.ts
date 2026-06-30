import { PrismaClient } from "@prisma/client";
import * as nodemailer from "nodemailer";
import { shouldCountRevenue } from "@/lib/booking-workflow";

type PrismaLike = PrismaClient;

type Period = "day" | "week" | "month" | "year";

const SHOP_NAME = process.env.SHOP_NAME || "The Nail Lounge @ Stokesley";
const OWNER_PHONE = process.env.REPORT_OWNER_PHONE || process.env.SHOP_OWNER_PHONE || process.env.OWNER_PHONE || "+447774292572";
const OWNER_EMAIL = process.env.REPORT_OWNER_EMAIL || process.env.SHOP_OWNER_EMAIL || process.env.OWNER_EMAIL || process.env.FROM_EMAIL || process.env.SMTP_FROM || "";

function asDate(value?: string | null) {
  if (!value) return new Date();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addMonths(date: Date, months: number) {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

function isoDay(date: Date) {
  return date.toISOString().slice(0, 10);
}

function money(value: unknown) {
  const n = Number(value || 0);
  return `£${Number.isFinite(n) ? n.toFixed(2) : "0.00"}`;
}

export function numberMoney(value: unknown) {
  const n = Number(value || 0);
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

export function resolvePeriod(periodParam?: string | null, dateParam?: string | null): { period: Period; start: Date; end: Date; label: string } {
  const period: Period = periodParam === "week" || periodParam === "month" || periodParam === "year" ? periodParam : "day";
  const base = asDate(dateParam);
  if (period === "year") {
    const start = new Date(Date.UTC(base.getUTCFullYear(), 0, 1));
    const end = new Date(Date.UTC(base.getUTCFullYear() + 1, 0, 1));
    return { period, start, end, label: String(base.getUTCFullYear()) };
  }
  if (period === "month") {
    const start = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1));
    const end = addMonths(start, 1);
    return { period, start, end, label: start.toISOString().slice(0, 7) };
  }
  if (period === "week") {
    const day = startOfUtcDay(base);
    const weekday = day.getUTCDay() || 7;
    const start = addDays(day, 1 - weekday);
    const end = addDays(start, 7);
    return { period, start, end, label: `${isoDay(start)} to ${isoDay(addDays(end, -1))}` };
  }
  const start = startOfUtcDay(base);
  const end = addDays(start, 1);
  return { period, start, end, label: isoDay(start) };
}

function servicesText(booking: any) {
  return (booking.services || []).map((item: any) => item.service?.name).filter(Boolean).join(", ") || "Service";
}

function staffText(booking: any) {
  return booking.staff?.name || booking.requestedStaff?.name || "Any Staff";
}

export async function buildCustomerReport(prisma: PrismaLike, periodParam?: string | null, dateParam?: string | null) {
  const range = resolvePeriod(periodParam, dateParam);
  const [bookings, users] = await Promise.all([
    prisma.booking.findMany({
      where: { date: { gte: range.start, lt: range.end }, archivedAt: null },
      include: { services: { include: { service: true } }, staff: true, requestedStaff: true, user: true },
      orderBy: [{ date: "asc" }, { time: "asc" }],
    }),
    prisma.user.findMany({ where: { role: "CUSTOMER" }, orderBy: { createdAt: "desc" } }),
  ]);

  const byKey = new Map<string, any>();
  for (const user of users) {
    const key = String(user.email || user.phone || user.id).toLowerCase();
    if (!key) continue;
    byKey.set(key, {
      key,
      userId: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone || "",
      totalBookings: 0,
      confirmedBookings: 0,
      cancelledBookings: 0,
      noShowBookings: 0,
      spend: 0,
      firstBookingAt: null,
      lastBookingAt: null,
      lastService: "",
      lastStaff: "",
      source: "Account",
    });
  }

  for (const booking of bookings) {
    const key = String(booking.customerEmail || booking.customerPhone || booking.userId || booking.id).toLowerCase();
    const row = byKey.get(key) || {
      key,
      userId: booking.userId,
      name: booking.customerName,
      email: booking.customerEmail || "",
      phone: booking.customerPhone || "",
      totalBookings: 0,
      confirmedBookings: 0,
      cancelledBookings: 0,
      noShowBookings: 0,
      spend: 0,
      firstBookingAt: null,
      lastBookingAt: null,
      lastService: "",
      lastStaff: "",
      source: "Booking",
    };
    row.name = row.name || booking.customerName;
    row.email = row.email || booking.customerEmail || "";
    row.phone = row.phone || booking.customerPhone || "";
    row.totalBookings += 1;
    if (["CONFIRMED", "COMPLETED"].includes(booking.status)) row.confirmedBookings += 1;
    if (booking.status === "CANCELLED") row.cancelledBookings += 1;
    if (booking.status === "NO_SHOW") row.noShowBookings += 1;
    if (shouldCountRevenue(booking.status)) row.spend += Number(booking.totalPrice || 0);
    const day = `${isoDay(booking.date)} ${booking.time}`;
    if (!row.firstBookingAt || day < row.firstBookingAt) row.firstBookingAt = day;
    if (!row.lastBookingAt || day > row.lastBookingAt) {
      row.lastBookingAt = day;
      row.lastService = servicesText(booking);
      row.lastStaff = staffText(booking);
    }
    byKey.set(key, row);
  }

  const customers = Array.from(byKey.values())
    .filter((row) => row.totalBookings > 0 || row.source === "Account")
    .sort((a, b) => String(b.lastBookingAt || b.key).localeCompare(String(a.lastBookingAt || a.key)));

  return {
    range,
    summary: {
      customers: customers.length,
      activeInPeriod: customers.filter((c) => c.totalBookings > 0).length,
      bookings: bookings.length,
      spend: numberMoney(customers.reduce((sum, row) => sum + row.spend, 0)),
      cancelled: bookings.filter((b) => b.status === "CANCELLED").length,
      noShow: bookings.filter((b) => b.status === "NO_SHOW").length,
    },
    customers: customers.map((row) => ({ ...row, spend: numberMoney(row.spend) })),
  };
}

export async function buildRevenueReport(prisma: PrismaLike, periodParam?: string | null, dateParam?: string | null) {
  const range = resolvePeriod(periodParam, dateParam);
  const [bookings, bankEntries] = await Promise.all([
    prisma.booking.findMany({
      where: { date: { gte: range.start, lt: range.end }, archivedAt: null },
      include: { services: { include: { service: true } }, staff: true, requestedStaff: true },
      orderBy: [{ date: "asc" }, { time: "asc" }],
    }),
    (prisma as any).bankStatementEntry.findMany({
      where: { transactionDate: { gte: range.start, lt: range.end } },
      orderBy: [{ transactionDate: "asc" }, { createdAt: "asc" }],
      take: 500,
    }).catch(() => []),
  ]);
  const revenueBookings = bookings.filter((booking) => shouldCountRevenue(booking.status));
  const cancelled = bookings.filter((booking) => booking.status === "CANCELLED");
  const pending = bookings.filter((booking) => booking.status === "PENDING");
  const noShow = bookings.filter((booking) => booking.status === "NO_SHOW");
  const totalRevenue = revenueBookings.reduce((sum, booking) => sum + Number(booking.totalPrice || 0), 0);
  const discounts = bookings.reduce((sum, booking) => sum + Number(booking.discount || 0), 0);
  const deposits = bookings.filter((booking: any) => booking.depositRequired).reduce((sum: number, booking: any) => sum + Number(booking.depositAmount || 0), 0);
  const bankCredits = bankEntries.filter((entry: any) => Number(entry.amount || 0) > 0);
  const bankDebits = bankEntries.filter((entry: any) => Number(entry.amount || 0) < 0);
  const bankCreditTotal = bankCredits.reduce((sum: number, entry: any) => sum + Number(entry.amount || 0), 0);
  const bankDebitTotal = bankDebits.reduce((sum: number, entry: any) => sum + Math.abs(Number(entry.amount || 0)), 0);
  const bankMatchedTotal = bankCredits.filter((entry: any) => entry.matchedBookingId).reduce((sum: number, entry: any) => sum + Number(entry.amount || 0), 0);

  const serviceTotals = new Map<string, { service: string; count: number; revenue: number }>();
  for (const booking of revenueBookings) {
    const names = (booking.services || []).map((item: any) => item.service?.name).filter(Boolean);
    for (const name of names.length ? names : ["Service"]) {
      const row = serviceTotals.get(name) || { service: name, count: 0, revenue: 0 };
      row.count += 1;
      row.revenue += Number(booking.totalPrice || 0) / Math.max(1, names.length || 1);
      serviceTotals.set(name, row);
    }
  }

  return {
    range,
    ownerPhone: OWNER_PHONE,
    ownerEmail: OWNER_EMAIL,
    summary: {
      totalRevenue: numberMoney(totalRevenue),
      bookingCount: bookings.length,
      revenueBookingCount: revenueBookings.length,
      pendingCount: pending.length,
      cancelledCount: cancelled.length,
      noShowCount: noShow.length,
      discountTotal: numberMoney(discounts),
      expectedDeposits: numberMoney(deposits),
      bankTransferConfirmed: bookings.filter((b) => b.paymentConfirmedAt).length,
      bankStatementCreditTotal: numberMoney(bankCreditTotal),
      bankStatementDebitTotal: numberMoney(bankDebitTotal),
      bankStatementMatchedTotal: numberMoney(bankMatchedTotal),
      bankStatementUnmatchedCount: bankCredits.filter((entry: any) => !entry.matchedBookingId).length,
      bankStatementEntryCount: bankEntries.length,
    },
    serviceTotals: Array.from(serviceTotals.values()).map((row) => ({ ...row, revenue: numberMoney(row.revenue) })).sort((a, b) => b.revenue - a.revenue),
    bankEntries: bankEntries.map((entry: any) => ({
      id: entry.id,
      transactionDate: entry.transactionDate?.toISOString?.().slice(0, 10) || entry.transactionDate,
      description: entry.description,
      reference: entry.reference,
      amount: numberMoney(entry.amount),
      currency: entry.currency,
      type: entry.type,
      matchedBookingId: entry.matchedBookingId,
      matchedConfidence: entry.matchedConfidence == null ? null : Number(entry.matchedConfidence),
    })),
    bookings: bookings.map((booking) => ({
      id: booking.id,
      reference: booking.paymentReference || `NL-${booking.id.slice(-8).toUpperCase()}`,
      date: isoDay(booking.date),
      time: booking.time,
      customerName: booking.customerName,
      customerPhone: booking.customerPhone,
      customerEmail: booking.customerEmail,
      status: booking.status,
      totalPrice: numberMoney(booking.totalPrice),
      discount: booking.discount == null ? null : numberMoney(booking.discount),
      staff: staffText(booking),
      services: servicesText(booking),
      paymentConfirmedAt: booking.paymentConfirmedAt,
    })),
  };
}

function pdfEscape(value: unknown) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrapLine(value: string, width = 98) {
  const words = String(value || "").split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > width) {
      if (line) lines.push(line);
      line = word;
    } else {
      line = (line + " " + word).trim();
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

export function simplePdf(title: string, rawLines: string[]) {
  const lines = [title, `Generated: ${new Date().toISOString()}`, "", ...rawLines].flatMap((line) => wrapLine(line));
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += 48) pages.push(lines.slice(i, i + 48));
  if (!pages.length) pages.push([title]);

  const objects: string[] = [];
  const add = (body: string) => { objects.push(body); return objects.length; };
  const catalogId = add("<< /Type /Catalog /Pages 2 0 R >>");
  const pagesId = add("PAGES_PLACEHOLDER");
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds: number[] = [];

  for (const pageLines of pages) {
    const stream = `BT\n/F1 10 Tf\n12 TL\n40 790 Td\n${pageLines.map((line) => `(${pdfEscape(line)}) Tj T*`).join("\n")}\nET`;
    const contentId = add(`<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`);
    const pageId = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }

  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  void catalogId;

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}


function csvCell(value: unknown) {
  const s = String(value ?? "");
  return `"${s.replace(/"/g, '""')}"`;
}

export function csvBuffer(headers: string[], rows: unknown[][]) {
  const lines = [headers.map(csvCell).join(","), ...rows.map((row) => row.map(csvCell).join(","))];
  return Buffer.from(lines.join("\n"), "utf8");
}

export function customerReportCsv(report: Awaited<ReturnType<typeof buildCustomerReport>>) {
  return csvBuffer(
    ["Name", "Email", "Phone", "Bookings", "Confirmed", "Cancelled", "No Show", "Spend", "First Booking", "Last Booking", "Last Service", "Last Staff", "Source"],
    report.customers.map((c: any) => [c.name, c.email, c.phone, c.totalBookings, c.confirmedBookings, c.cancelledBookings, c.noShowBookings, c.spend, c.firstBookingAt, c.lastBookingAt, c.lastService, c.lastStaff, c.source])
  );
}

export function revenueReportCsv(report: Awaited<ReturnType<typeof buildRevenueReport>>) {
  return csvBuffer(
    ["Reference", "Date", "Time", "Customer", "Phone", "Email", "Status", "Total", "Discount", "Staff", "Services", "Payment Confirmed At"],
    report.bookings.map((b: any) => [b.reference, b.date, b.time, b.customerName, b.customerPhone, b.customerEmail, b.status, b.totalPrice, b.discount ?? "", b.staff, b.services, b.paymentConfirmedAt || ""])
  );
}

export function customerReportPdf(report: Awaited<ReturnType<typeof buildCustomerReport>>) {
  const lines = [
    `Period: ${report.range.label}`,
    `Customers in report: ${report.summary.customers}`,
    `Active in period: ${report.summary.activeInPeriod}`,
    `Bookings: ${report.summary.bookings}`,
    `Spend: ${money(report.summary.spend)}`,
    `Cancelled: ${report.summary.cancelled} | No-show: ${report.summary.noShow}`,
    "",
    "Customers:",
    ...report.customers.slice(0, 180).map((c: any, index: number) => `${index + 1}. ${c.name || "Unknown"} | ${c.email || "no email"} | ${c.phone || "no phone"} | bookings ${c.totalBookings} | spend ${money(c.spend)} | last ${c.lastBookingAt || "-"} | ${c.lastService || "-"}`),
  ];
  return simplePdf(`${SHOP_NAME} - Customer Data Report`, lines);
}

export function revenueReportPdf(report: Awaited<ReturnType<typeof buildRevenueReport>>) {
  const lines = [
    `Period: ${report.range.label}`,
    `Total revenue: ${money(report.summary.totalRevenue)}`,
    `Revenue bookings: ${report.summary.revenueBookingCount}/${report.summary.bookingCount}`,
    `Pending: ${report.summary.pendingCount} | Cancelled: ${report.summary.cancelledCount} | No-show: ${report.summary.noShowCount}`,
    `Discount total: ${money(report.summary.discountTotal)} | Expected deposits: ${money(report.summary.expectedDeposits)}`,
    `Bank transfer/payment confirmed count: ${report.summary.bankTransferConfirmed}`,
    `Bank statement credits: ${money(report.summary.bankStatementCreditTotal)} | debits: ${money(report.summary.bankStatementDebitTotal)} | matched: ${money(report.summary.bankStatementMatchedTotal)} | unmatched credits: ${report.summary.bankStatementUnmatchedCount}`,
    "",
    "Top services:",
    ...(report.serviceTotals.length ? report.serviceTotals.map((s: any) => `- ${s.service}: ${s.count} booking(s), ${money(s.revenue)}`) : ["- No service revenue in this period"]),
    "",
    "Bookings:",
    ...report.bookings.slice(0, 180).map((b: any) => `${b.reference} | ${b.date} ${b.time} | ${b.customerName} | ${b.status} | ${money(b.totalPrice)} | ${b.staff} | ${b.services}`),
  ];
  return simplePdf(`${SHOP_NAME} - Revenue / Bank Report`, lines);
}

export function dailySmsText(report: Awaited<ReturnType<typeof buildRevenueReport>>) {
  return `${SHOP_NAME} daily revenue ${report.range.label}: ${money(report.summary.totalRevenue)} from ${report.summary.revenueBookingCount} paid/confirmed booking(s). Pending ${report.summary.pendingCount}, cancelled ${report.summary.cancelledCount}, no-show ${report.summary.noShowCount}. Bank-confirmed ${report.summary.bankTransferConfirmed}.`;
}

function hasSmtpProvider() {
  return Boolean(process.env.SMTP_HOST && (process.env.SMTP_FROM || process.env.FROM_EMAIL));
}

function hasResendProvider() {
  return Boolean(process.env.RESEND_API_KEY && process.env.FROM_EMAIL);
}

export async function sendReportEmail(args: { to: string; subject: string; text: string; pdf: Buffer; filename: string }) {
  if (!args.to) throw new Error("Report email recipient is required");
  if (hasSmtpProvider()) {
    const port = Number(process.env.SMTP_PORT || 587);
    const secure = String(process.env.SMTP_SECURE || "").toLowerCase() === "true" || port === 465;
    const user = process.env.SMTP_USER || "";
    const pass = process.env.SMTP_PASS || "";
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure,
      auth: user || pass ? { user, pass } : undefined,
    });
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.FROM_EMAIL,
      to: args.to,
      subject: args.subject,
      text: args.text,
      html: `<p>${args.text.replace(/\n/g, "<br />")}</p>`,
      attachments: [{ filename: args.filename, content: args.pdf, contentType: "application/pdf" }],
    });
    return { provider: "smtp", messageId: info.messageId || null };
  }

  if (hasResendProvider()) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: String.fromCharCode(66, 101, 97, 114, 101, 114) + " " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.FROM_EMAIL,
        to: [args.to],
        subject: args.subject,
        text: args.text,
        attachments: [{ filename: args.filename, content: args.pdf.toString("base64") }],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || `Resend HTTP ${res.status}`);
    return { provider: "resend", messageId: data?.id || null };
  }

  throw new Error("Email provider not configured: set SMTP_HOST and SMTP_FROM/FROM_EMAIL, or RESEND_API_KEY and FROM_EMAIL");
}

export function defaultOwnerPhone() {
  return OWNER_PHONE;
}

export function defaultOwnerEmail() {
  return OWNER_EMAIL;
}
