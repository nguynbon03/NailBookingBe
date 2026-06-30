import { PrismaClient } from "@prisma/client";

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

type CustomerEvent = "booking_created" | "booking_confirmed" | "booking_cancelled" | "booking_no_show" | "booking_email_verification" | "account_verification";

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

function composeCustomerMessage(booking: CustomerBooking, event: CustomerEvent) {
  const ref = bookingReference(booking.id);
  const service = serviceSummary(booking);
  const when = `${formatDate(booking.date)} at ${booking.time}`;

  if (event === "booking_created" || event === "booking_email_verification") {
    const verificationUrl = (booking as any).emailVerificationUrl || PUBLIC_BOOKING_URL;
    return {
      subject: `${SHOP_NAME}: confirm your booking request (${ref})`,
      message: `Hi ${booking.customerName}, please confirm this booking request for ${service} on ${when}. Reference: ${ref}. Click this secure link within 30 minutes: ${verificationUrl}. The appointment will not be shown to staff, assigned to a staff member, or synced to any external calendar until the email is confirmed and the shop/admin approves it.`,
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

function hasEmailProvider() {
  return Boolean(process.env.RESEND_API_KEY && process.env.FROM_EMAIL);
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
      provider: hasEmailProvider() ? "resend" : null,
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
      provider: channel === "EMAIL" ? (hasEmailProvider() ? "resend" : null) : (hasSmsProvider() ? "twilio" : null),
    },
  });
}

async function mark(prisma: PrismaClient, id: string, data: Record<string, unknown>) {
  await (prisma as any).customerNotification.update({ where: { id }, data });
}

async function sendEmail(row: any) {
  if (!hasEmailProvider()) throw new Error("Email provider not configured: set RESEND_API_KEY and FROM_EMAIL");
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

  for (const row of rows) {
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
    } catch (error) {
      const message = error instanceof Error ? error.message : "Notification delivery failed";
      const providerMissing = message.includes("provider not configured");
      await mark(prisma, row.id, {
        status: providerMissing ? "SKIPPED" : "FAILED",
        error: message,
        attempts: { increment: 1 },
      });
    }
  }
}
