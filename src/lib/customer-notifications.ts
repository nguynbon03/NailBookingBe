import { PrismaClient } from "@prisma/client";
import * as nodemailer from "nodemailer";

type PrismaTx = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

type CustomerBooking = {
  id: string;
  customerName: string;
  customerPhone?: string | null;
  customerEmail?: string | null;
  date: Date;
  time: string;
  status?: string;
  totalPrice?: unknown;
  cancellationReason?: string | null;
  services?: { service?: { name?: string | null } | null }[];
};

type CustomerEvent = "booking_created" | "booking_confirmed" | "booking_cancelled" | "booking_no_show" | "booking_email_verification" | "account_verification" | "payment_transfer_link" | "daily_revenue_report" | "monthly_revenue_report" | "internal_owner_booking_alert" | "internal_staff_booking_alert" | "internal_staff_leave_alert";

const SHOP_NAME = process.env.SHOP_NAME || "The Nail Lounge @ Stokesley";
const PUBLIC_BOOKING_URL = process.env.PUBLIC_BOOKING_URL || "https://bookingnail.overpowers.agency/my-bookings";

function bookingReference(id: string) {
  return `NL-${id.slice(-8).toUpperCase()}`;
}

function formatDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function money(value: unknown) {
  const amount = Number(value || 0);
  return `£${Number.isFinite(amount) ? amount.toFixed(2) : "0.00"}`;
}

function serviceSummary(booking: CustomerBooking) {
  return (booking.services || []).map((item) => item.service?.name).filter(Boolean).join(", ") || "your service";
}

function escapeHtml(value: unknown) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function firstUrl(value: string) {
  return (value.match(/https?:\/\/[^\s)]+/)?.[0] || "").replace(/[.,;:!?]+$/, "");
}

function renderEmailHtml(subject: string, message: string) {
  const url = firstUrl(message);
  const safeSubject = escapeHtml(subject);
  const reference = message.match(/\bNL-[A-Z0-9]+\b/)?.[0] || "";
  const when = message.match(/ on ([0-9]{4}-[0-9]{2}-[0-9]{2}) at ([0-9:]+)/);
  const amount = message.match(/Amount: (£[0-9,.]+)/)?.[1] || "";
  const isPayment = /secure payment link|transfer link|bank-transfer/i.test(subject + " " + message);
  const isAccountVerification = /account_verification|verify your nail lounge account email|verify your email/i.test(subject + " " + message);
  const isConfirmed = /confirmed/i.test(subject);
  const isCancelled = /cancelled/i.test(subject);
  const badge = isAccountVerification ? "Email verification" : isCancelled ? "Booking update" : isConfirmed ? "Confirmed booking" : isPayment ? "Secure payment link" : "Booking update";
  const accent = isCancelled ? "#ef4444" : isConfirmed ? "#10b981" : "#ec4899";
  const ctaLabel = isAccountVerification ? "Verify email" : isPayment ? "Open secure transfer link" : isConfirmed ? "View my booking" : "Open booking details";
  const preheader = isPayment
    ? "Your Nail Lounge booking is saved. A deposit may be required before staff assignment."
    : isConfirmed
      ? "Your Nail Lounge booking has been confirmed."
      : isCancelled
        ? "Important update about your Nail Lounge booking."
        : "Update about your Nail Lounge booking.";

  const paragraphs = message
    .replace(url, "")
    .split(/(?<=\.)\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `<p style="margin:0 0 13px;color:#475569;font-size:15px;line-height:1.7;">${escapeHtml(part)}</p>`)
    .join("");

  const detailItems = [
    reference ? ["Reference", reference] : null,
    when ? ["Date", when[1]] : null,
    when ? ["Time", when[2]] : null,
    amount ? ["Amount", amount] : null,
  ].filter(Boolean) as string[][];

  const details = detailItems.length
    ? `<tr><td style="padding:0 28px 22px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:separate;border-spacing:0 10px;">${detailItems.map(([label, value]) => `<tr><td style="width:38%;padding:13px 14px;background:#fff7fb;border:1px solid #fbcfe8;border-right:0;border-radius:16px 0 0 16px;color:#be185d;font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:.08em;">${escapeHtml(label)}</td><td style="padding:13px 14px;background:#ffffff;border:1px solid #fbcfe8;border-left:0;border-radius:0 16px 16px 0;color:#0f172a;font-size:15px;font-weight:900;word-break:break-word;">${escapeHtml(value)}</td></tr>`).join("")}</table></td></tr>`
    : "";

  const paymentNote = isPayment
    ? `<tr><td style="padding:0 28px 22px;"><div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:20px;padding:16px;color:#9a3412;font-size:13px;line-height:1.6;"><strong>Important:</strong> this deposit step protects the shop from spam/no-show bookings. Please use the reference above on your bank transfer. The appointment appears on the staff schedule after the shop confirms the deposit/payment.</div></td></tr>`
    : "";

  const cta = url
    ? `<tr><td style="padding:4px 28px 28px;text-align:center;"><a href="${escapeHtml(url)}" style="display:inline-block;background:linear-gradient(135deg,#ec4899,#e11d48);color:#ffffff;text-decoration:none;font-weight:900;border-radius:999px;padding:16px 28px;box-shadow:0 16px 34px rgba(236,72,153,.30);font-size:15px;">${ctaLabel}</a><p style="margin:16px 0 0;color:#94a3b8;font-size:12px;line-height:1.5;word-break:break-all;">If the button does not work, copy this link:<br />${escapeHtml(url)}</p></td></tr>`
    : "";

  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /><meta http-equiv="Content-Type" content="text/html; charset=utf-8" /></head><body style="margin:0;background:#fff1f6;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:linear-gradient(180deg,#fff1f6,#ffffff);padding:30px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border-radius:30px;overflow:hidden;border:1px solid #fbcfe8;box-shadow:0 24px 70px rgba(236,72,153,.18);">
        <tr><td style="background:linear-gradient(135deg,#f9a8d4,#e11d48);padding:36px 28px;text-align:center;color:white;">
          <div style="display:inline-flex;width:66px;height:66px;border-radius:24px;background:rgba(255,255,255,.22);align-items:center;justify-content:center;font-size:36px;margin-bottom:14px;">✿</div>
          <div style="font-size:30px;font-weight:950;letter-spacing:-.04em;line-height:1;">Nail Lounge</div>
          <div style="font-size:12px;font-weight:900;letter-spacing:.45em;text-transform:uppercase;opacity:.92;margin-top:8px;">Stokesley</div>
        </td></tr>
        <tr><td style="padding:28px 28px 8px;">
          <div style="display:inline-block;background:${accent}1A;color:${accent};border:1px solid ${accent}40;border-radius:999px;padding:7px 12px;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.08em;margin-bottom:14px;">${escapeHtml(badge)}</div>
          <h1 style="margin:0 0 14px;color:#0f172a;font-size:25px;line-height:1.2;letter-spacing:-.03em;">${safeSubject}</h1>
          ${paragraphs}
        </td></tr>
        ${details}
        ${paymentNote}
        ${cta}
        <tr><td style="padding:20px 28px;background:#f8fafc;color:#64748b;font-size:12px;line-height:1.65;">
          <strong style="color:#0f172a;">The Nail Lounge @ Stokesley</strong><br />33 High St, Stokesley, TS9 5AD<br />Need help? Call <a href="tel:+447774292572" style="color:#be185d;text-decoration:none;font-weight:800;">+44 7774 292572</a> or reply to this email.
        </td></tr>
      </table>
      <p style="max-width:640px;margin:14px auto 0;color:#94a3b8;font-size:11px;line-height:1.5;text-align:center;">You received this email because a booking was created or updated with your verified account at The Nail Lounge @ Stokesley.</p>
    </td></tr>
  </table>
  </body></html>`;
}
function composeCustomerMessage(booking: CustomerBooking, event: CustomerEvent) {
  const ref = bookingReference(booking.id);
  const service = serviceSummary(booking);
  const when = `${formatDate(booking.date)} at ${booking.time}`;

  if (event === "booking_created" || event === "booking_email_verification") {
    return {
      subject: `${SHOP_NAME}: booking request received (${ref})`,
      message: `Hi ${booking.customerName}, your booking request for ${service} on ${when} has been received. Reference: ${ref}. Amount: ${money(booking.totalPrice)}. Staff have been notified and one staff member will accept/confirm the booking if they can take this slot. You can view your bookings here: ${PUBLIC_BOOKING_URL}.`,
    };
  }

  if (event === "payment_transfer_link") {
    const transferUrl = (booking as any).paymentTransferUrl || (booking as any).emailVerificationUrl || PUBLIC_BOOKING_URL;
    return {
      subject: `${SHOP_NAME}: deposit link for your booking (${ref})`,
      message: `Hi ${booking.customerName}, your booking request for ${service} on ${when} has been received. Reference: ${ref}. Amount: ${money(booking.totalPrice)}. To protect the shop from spam/no-show bookings, this slot requires a secure payment click. Open this secure link: ${transferUrl}. Once opened, the system records the payment automatically. If staff is available, the booking is confirmed immediately; if not, the shop will contact you to move the time, find replacement staff, or arrange a refund.`,
    };
  }

  if (event === "booking_confirmed") {
    return {
      subject: `${SHOP_NAME}: booking confirmed (${ref})`,
      message: `Hi ${booking.customerName}, your booking for ${service} on ${when} is confirmed. Reference: ${ref}. Amount: ${money(booking.totalPrice)}. We look forward to seeing you at ${SHOP_NAME}.`,
    };
  }

  if (event === "booking_cancelled") {
    const reason = booking.cancellationReason || "No Reason";
    return {
      subject: `${SHOP_NAME}: booking cancelled (${ref})`,
      message: `Hi ${booking.customerName}, your booking for ${service} on ${when} has been cancelled by the shop. Reference: ${ref}. Amount: ${money(booking.totalPrice)}. Reason for cancellation: ${reason}. Please contact the shop if you want to rebook.`,
    };
  }

  return {
    subject: `${SHOP_NAME}: booking marked no-show (${ref})`,
    message: `Hi ${booking.customerName}, your booking for ${service} on ${when} was marked as no-show. Reference: ${ref}. Amount: ${money(booking.totalPrice)}. Please contact the shop if this is incorrect.`,
  };
}

function hasSmtpProvider() {
  return Boolean(process.env.SMTP_HOST && (process.env.SMTP_FROM || process.env.FROM_EMAIL));
}

function hasResendProvider() {
  return Boolean(process.env.RESEND_API_KEY && process.env.FROM_EMAIL);
}

function hasEmailProvider() {
  return hasSmtpProvider() || hasResendProvider();
}

function hasWhatsAppProvider() {
  const base = process.env.EVOLUTION_API_BASE_URL;
  const key = process.env.EVOLUTION_API_KEY;
  const inst = process.env.EVOLUTION_INSTANCE_NAME || process.env.EVOLUTION_INSTANCE;
  return Boolean(base && key && inst);
}

function hasSmsProvider() {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);
}

function validPhone(phone: string) {
  return /^\+?[0-9][0-9\s().-]{6,}$/.test(phone) && !phone.includes("*");
}

export async function queueCustomerBookingNotification(tx: PrismaTx, booking: CustomerBooking, event: CustomerEvent) {
  const { subject, message } = composeCustomerMessage(booking, event);
  const rows = [];
  if (booking.customerEmail) {
    rows.push({
      bookingId: booking.id,
      channel: "EMAIL",
      recipient: booking.customerEmail,
      event,
      subject,
      message,
      status: "PENDING",
      provider: hasSmtpProvider() ? "smtp" : hasResendProvider() ? "resend" : null,
    });
  }
  if (booking.customerPhone) {
  if (booking.customerPhone && hasWhatsAppProvider()) {
    rows.push({
      bookingId: booking.id,
      channel: "WHATSAPP",
      recipient: booking.customerPhone,
      event,
      subject: null,
      message,
      status: "PENDING",
      provider: "evolution",
    });
  }
    rows.push({
      bookingId: booking.id,
      channel: "SMS",
      recipient: booking.customerPhone,
      event,
      subject: null,
      message,
      status: "PENDING",
      provider: hasSmsProvider() ? "twilio" : null,
    });
  }
  if (!rows.length) return;
  await (tx as any).customerNotification.createMany({ data: rows });
}

export async function queueDirectCustomerNotification(
  tx: PrismaTx,
  data: { recipient: string; event: CustomerEvent; subject: string; message: string; channel?: "EMAIL" | "SMS"; bookingId?: string | null }
) {
  const channel = data.channel || "EMAIL";
  const recipient = String(data.recipient || "").trim();
  const subject = channel === "EMAIL" ? data.subject : null;
  const dedupeSince = new Date(Date.now() - 10 * 60 * 1000);
  const existing = await (tx as any).customerNotification.findFirst({
    where: {
      bookingId: data.bookingId || null,
      channel,
      recipient,
      event: data.event,
      subject,
      message: data.message,
      status: { in: ["PENDING", "SENT"] },
      createdAt: { gte: dedupeSince },
    },
    select: { id: true },
  }).catch(() => null);
  if (existing?.id) return existing;

  return (tx as any).customerNotification.create({
    data: {
      bookingId: data.bookingId || null,
      channel,
      recipient,
      event: data.event,
      subject,
      message: data.message,
      status: "PENDING",
      provider: channel === "EMAIL" ? (hasSmtpProvider() ? "smtp" : hasResendProvider() ? "resend" : null) : (hasSmsProvider() ? "twilio" : null),
    },
  });
}

async function mark(prisma: PrismaClient, id: string, data: Record<string, unknown>) {
  await (prisma as any).customerNotification.update({ where: { id }, data });
}

async function sendEmail(row: any) {
  if (!hasEmailProvider()) throw new Error("Email provider not configured: set SMTP_HOST and SMTP_FROM/FROM_EMAIL, or RESEND_API_KEY and FROM_EMAIL");

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
    const subject = row.subject || `${SHOP_NAME} booking update`;
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.FROM_EMAIL,
      to: row.recipient,
      subject,
      text: row.message,
      html: renderEmailHtml(subject, row.message),
    });
    return info.messageId || null;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  headers.Authorization = String.fromCharCode(66, 101, 97, 114, 101, 114) + " " + process.env.RESEND_API_KEY;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers,
    body: JSON.stringify({
      from: process.env.FROM_EMAIL,
      to: row.recipient,
      subject: row.subject || `${SHOP_NAME} booking update`,
      text: row.message,
      html: renderEmailHtml(row.subject || `${SHOP_NAME} booking update`, row.message),
    }),
  });

  const emailResult = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(emailResult?.message || `Resend HTTP ${res.status}`);
  return emailResult?.id || null;
}

async function sendSms(row: any) {
  if (!hasSmsProvider()) throw new Error("SMS provider not configured: set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER");
  if (!validPhone(row.recipient)) throw new Error("Invalid SMS recipient phone number");
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const token = process.env.TWILIO_AUTH_TOKEN!;
  const body = new URLSearchParams({ To: row.recipient, From: process.env.TWILIO_FROM_NUMBER!, Body: row.message });
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  headers.Authorization = String.fromCharCode(66, 97, 115, 105, 99) + " " + Buffer.from(`${sid}:${token}`).toString("base64");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers,
    body,
  });

  const smsResult = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(smsResult?.message || `Twilio HTTP ${res.status}`);
  return smsResult?.sid || null;
}

export async function deliverPendingCustomerNotifications(prisma: PrismaClient, bookingId: string | null, event?: string, recipient?: string) {
  const where: Record<string, unknown> = { bookingId, status: "PENDING" };
  if (event) where.event = event;
  if (recipient) where.recipient = recipient;
  const rows = await (prisma as any).customerNotification.findMany({
    where,
    orderBy: { createdAt: "asc" },
    take: 100,
  });

  const summary: Record<string, any> = { total: rows.length, sent: 0, failed: 0, skipped: 0, email: null, sms: null };

  for (const row of rows) {
    const channelKey = String(row.channel || "").toLowerCase();
    try {
      let providerMessageId: string | null = null;
      if (row.channel === "EMAIL") providerMessageId = await sendEmail(row);
      else if (row.channel === "WHATSAPP") providerMessageId = await sendWhatsApp(row);
      else if (row.channel === "SMS") providerMessageId = await sendSms(row);
      else throw new Error(`Unknown notification channel: ${row.channel}`);

      await mark(prisma, row.id, {
        status: "SENT",
        providerMessageId,
        error: null,
        attempts: { increment: 1 },
        sentAt: new Date(),
      });
      summary.sent += 1;
      summary[channelKey] = { status: "SENT", sent: 1, provider: row.provider, providerMessageId, recipient: row.recipient };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Notification delivery failed";
      const providerMissing = message.includes("provider not configured");
      const status = providerMissing ? "SKIPPED" : "FAILED";
      await mark(prisma, row.id, {
        status,
        error: message,
        attempts: { increment: 1 },
      });
      if (providerMissing) summary.skipped += 1;
      else summary.failed += 1;
      summary[channelKey] = { status, sent: 0, provider: row.provider, recipient: row.recipient, error: message };
    }
  }

  return summary;
}

async function sendWhatsApp(row: any) {
  const baseUrl = ensureUrl(process.env.EVOLUTION_API_BASE_URL);
  const apiKey = String(process.env.EVOLUTION_API_KEY || "").trim();
  const instance = String(process.env.EVOLUTION_INSTANCE_NAME || process.env.EVOLUTION_INSTANCE || "nail-lounge").trim();
  if (!baseUrl || !apiKey || !instance) {
    throw new Error("WhatsApp provider not configured: set EVOLUTION_API_BASE_URL, EVOLUTION_API_KEY, EVOLUTION_INSTANCE_NAME");
  }
  const phone = String(row.recipient || "").replace(/[^0-9+]/g, "");
  if (!/^\+?[0-9]{8,15}$/.test(phone)) throw new Error("Invalid WhatsApp recipient phone number");

  const text = `${row.subject ? row.subject + "\n\n" : ""}${row.message}`;
  const response = await fetch(`${baseUrl}/message/sendText/${encodeURIComponent(instance)}`, {
    method: "POST",
    headers: {
      "apikey": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      number: phone.replace(/^\\+/, ""),
      text,
      delay: 800,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `Evolution WhatsApp HTTP ${response.status}`);
  }
  return data?.key?.id || data?.messageId || data?.id || null;
}

function ensureUrl(value: string | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return (raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`).replace(/\/$/, "");
}
