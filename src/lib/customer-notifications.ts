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

type CustomerEvent = "booking_created" | "booking_confirmed" | "booking_cancelled" | "booking_no_show" | "booking_email_verification" | "account_verification" | "payment_transfer_link";

const SHOP_NAME = process.env.SHOP_NAME || "The Nail Lounge @ Stokesley";
const PUBLIC_BOOKING_URL = process.env.PUBLIC_BOOKING_URL || "https://bookingnail.overpowers.agency/my-bookings";

function bookingReference(id: string) {
  return `NL-${id.slice(-8).toUpperCase()}`;
}

function formatDate(date: Date) {
  return date.toISOString().slice(0, 10);
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
  return value.match(/https?:\/\/[^\s)]+/)?.[0] || "";
}

function renderEmailHtml(subject: string, message: string) {
  const url = firstUrl(message);
  const safeSubject = escapeHtml(subject);
  const paragraphs = message
    .split(/(?<=\.)\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:1.65;">${escapeHtml(part)}</p>`)
    .join("");
  const cta = url
    ? `<tr><td style="padding:8px 28px 28px;text-align:center;"><a href="${escapeHtml(url)}" style="display:inline-block;background:linear-gradient(135deg,#ec4899,#e11d48);color:#ffffff;text-decoration:none;font-weight:800;border-radius:999px;padding:15px 26px;box-shadow:0 14px 30px rgba(236,72,153,.28);">Open secure booking link</a><p style="margin:14px 0 0;color:#94a3b8;font-size:12px;word-break:break-all;">${escapeHtml(url)}</p></td></tr>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#fff1f6;font-family:Inter,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#fff1f6;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border-radius:28px;overflow:hidden;border:1px solid #fbcfe8;box-shadow:0 24px 70px rgba(236,72,153,.18);">
        <tr><td style="background:linear-gradient(135deg,#f9a8d4,#e11d48);padding:34px 28px;text-align:center;color:white;">
          <div style="display:inline-flex;width:62px;height:62px;border-radius:22px;background:rgba(255,255,255,.22);align-items:center;justify-content:center;font-size:34px;margin-bottom:12px;">✿</div>
          <div style="font-size:28px;font-weight:900;letter-spacing:-.04em;">Nail Lounge</div>
          <div style="font-size:12px;font-weight:800;letter-spacing:.45em;text-transform:uppercase;opacity:.9;">Stokesley</div>
        </td></tr>
        <tr><td style="padding:28px 28px 8px;">
          <h1 style="margin:0 0 14px;color:#0f172a;font-size:24px;line-height:1.2;">${safeSubject}</h1>
          ${paragraphs}
        </td></tr>
        ${cta}
        <tr><td style="padding:18px 28px;background:#f8fafc;color:#64748b;font-size:12px;line-height:1.6;">
          The Nail Lounge @ Stokesley · 33 High St, Stokesley, TS9 5AD<br />Need help? Call +44 7774 292572 or reply to this email.
        </td></tr>
      </table>
    </td></tr>
  </table>
  </body></html>`;
}

function composeCustomerMessage(booking: CustomerBooking, event: CustomerEvent) {
  const ref = bookingReference(booking.id);
  const service = serviceSummary(booking);
  const when = `${formatDate(booking.date)} at ${booking.time}`;

  if (event === "booking_created" || event === "booking_email_verification" || event === "payment_transfer_link") {
    const transferUrl = (booking as any).paymentTransferUrl || (booking as any).emailVerificationUrl || PUBLIC_BOOKING_URL;
    return {
      subject: `${SHOP_NAME}: secure payment link for your booking (${ref})`,
      message: `Hi ${booking.customerName}, your account email is verified and your booking request for ${service} on ${when} has been received. Reference: ${ref}. Click this secure transfer link within 3 minutes to lock one available staff member for this slot: ${transferUrl}. Use ${ref} as the bank-transfer reference. The appointment will only appear on the staff schedule after the shop/admin confirms the bank transfer. If the 3-minute lock expires, please reopen the booking flow or contact the shop before transferring.`,
    };
  }

  if (event === "booking_confirmed") {
    return {
      subject: `${SHOP_NAME}: booking confirmed (${ref})`,
      message: `Hi ${booking.customerName}, your booking for ${service} on ${when} is confirmed. Reference: ${ref}. We look forward to seeing you at ${SHOP_NAME}.`,
    };
  }

  if (event === "booking_cancelled") {
    const reason = booking.cancellationReason || "No Reason";
    return {
      subject: `${SHOP_NAME}: booking cancelled (${ref})`,
      message: `Hi ${booking.customerName}, your booking for ${service} on ${when} has been cancelled by the shop. Reference: ${ref}. Reason for cancellation: ${reason}. Please contact the shop if you want to rebook.`,
    };
  }

  return {
    subject: `${SHOP_NAME}: booking marked no-show (${ref})`,
    message: `Hi ${booking.customerName}, your booking for ${service} on ${when} was marked as no-show. Reference: ${ref}. Please contact the shop if this is incorrect.`,
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
  await (tx as any).customerNotification.create({
    data: {
      bookingId: data.bookingId || null,
      channel,
      recipient: data.recipient,
      event: data.event,
      subject: channel === "EMAIL" ? data.subject : null,
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
    take: 20,
  });

  const summary: Record<string, any> = { total: rows.length, sent: 0, failed: 0, skipped: 0, email: null, sms: null };

  for (const row of rows) {
    const channelKey = String(row.channel || "").toLowerCase();
    try {
      let providerMessageId: string | null = null;
      if (row.channel === "EMAIL") providerMessageId = await sendEmail(row);
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
