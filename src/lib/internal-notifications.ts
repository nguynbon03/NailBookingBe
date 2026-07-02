import { PrismaClient } from "@prisma/client";
import { queueDirectCustomerNotification } from "@/lib/customer-notifications";

type PrismaTx = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

type BookingLike = {
  id: string;
  userId?: string | null;
  staffId?: string | null;
  requestedStaffId?: string | null;
  customerName: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
  date: Date;
  time: string;
  status?: string;
  totalPrice?: unknown;
  cancellationReason?: string | null;
  staff?: { id?: string; name?: string | null; email?: string | null } | null;
  requestedStaff?: { id?: string; name?: string | null; email?: string | null } | null;
  services?: { service?: { name?: string | null; duration?: number | null } | null }[];
};

function dayText(value: Date | string | null | undefined) {
  const date = value instanceof Date ? value : new Date(String(value || ""));
  return Number.isNaN(date.getTime()) ? String(value || "").slice(0, 10) : date.toISOString().slice(0, 10);
}

function servicesText(booking: BookingLike) {
  return (booking.services || []).map((item) => item.service?.name).filter(Boolean).join(", ") || "service";
}

function money(value: unknown) {
  const n = Number(value || 0);
  return `£${Number.isFinite(n) ? n.toFixed(2) : "0.00"}`;
}

function uniq(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((v) => String(v || "").trim().toLowerCase()).filter((v) => v && v.includes("@"))));
}

export function bookingSummaryLine(booking: BookingLike) {
  return `${booking.customerName} · ${servicesText(booking)} · ${dayText(booking.date)} ${booking.time} · ${money(booking.totalPrice)} · status ${booking.status || "PENDING"}`;
}

export async function ownerEmails(tx: PrismaTx) {
  const envEmails = uniq([
    process.env.REPORT_OWNER_EMAIL,
    process.env.SHOP_OWNER_EMAIL,
    process.env.OWNER_EMAIL,
    process.env.FROM_EMAIL,
    process.env.SMTP_FROM,
  ]);
  const adminUsers = await tx.user.findMany({
    where: { role: { in: ["ADMIN", "MANAGER"] } },
    select: { email: true },
  }).catch(() => []);
  return uniq([...envEmails, ...adminUsers.map((user) => user.email)]);
}

async function queueInternalEmail(
  tx: PrismaTx,
  args: { recipient: string; event: "internal_owner_booking_alert" | "internal_staff_booking_alert" | "internal_staff_leave_alert"; subject: string; message: string; bookingId?: string | null }
) {
  await queueDirectCustomerNotification(tx, {
    recipient: args.recipient,
    channel: "EMAIL",
    event: args.event,
    subject: args.subject,
    message: args.message,
    bookingId: args.bookingId || null,
  });
}

export async function queueOwnerBookingEmail(tx: PrismaTx, booking: BookingLike, subject: string, extra = "") {
  const recipients = await ownerEmails(tx);
  if (!recipients.length) return;
  const message = `${subject}\n\n${bookingSummaryLine(booking)}\nCustomer email: ${booking.customerEmail || "-"}\nCustomer phone: ${booking.customerPhone || "-"}${extra ? `\n\n${extra}` : ""}\n\nOpen admin calendar/inbox: ${process.env.PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "https://bookingnail.overpowers.agency"}/admin/calendar`;
  await Promise.all(recipients.map((recipient) => queueInternalEmail(tx, {
    recipient,
    event: "internal_owner_booking_alert",
    subject: `Nail Lounge owner alert: ${subject}`,
    message,
    bookingId: booking.id,
  })));
}

export async function queueStaffBookingEmail(tx: PrismaTx, booking: BookingLike, subject: string, extra = "", staffIds?: Array<string | null | undefined>) {
  const ids = uniq(staffIds || [booking.staffId, booking.requestedStaffId]).filter(Boolean);
  const staff = ids.length
    ? await tx.staff.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, name: true, active: true } })
    : await tx.staff.findMany({ where: { active: true }, select: { id: true, email: true, name: true, active: true } });
  const recipients = uniq(staff.filter((item) => item.active !== false).map((item) => item.email));
  if (!recipients.length) return;
  const message = `${subject}\n\n${bookingSummaryLine(booking)}\nCustomer phone: ${booking.customerPhone || "-"}${extra ? `\n\n${extra}` : ""}\n\nOpen Staff Portal: ${process.env.PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "https://bookingnail.overpowers.agency"}/staff`;
  await Promise.all(recipients.map((recipient) => queueInternalEmail(tx, {
    recipient,
    event: "internal_staff_booking_alert",
    subject: `Nail Lounge staff alert: ${subject}`,
    message,
    bookingId: booking.id,
  })));
}

export async function queueCustomerWebsiteNotification(tx: PrismaTx, booking: BookingLike, title: string, message: string, type = "CUSTOMER_BOOKING_UPDATE") {
  if (!booking.userId) return;
  await tx.notification.create({
    data: {
      audience: "CUSTOMER",
      userId: booking.userId,
      bookingId: booking.id,
      type,
      title,
      message,
    },
  });
}

export async function queueOwnerLeaveEmail(tx: PrismaTx, leave: any, subject: string, extra = "") {
  const recipients = await ownerEmails(tx);
  if (!recipients.length) return;
  const staffName = leave.staff?.name || "Staff";
  const from = dayText(leave.startDate);
  const to = dayText(leave.endDate);
  const message = `${subject}\n\n${staffName} requested/updated leave from ${from} to ${to}.\nReason: ${leave.reason || "-"}\nStatus: ${leave.status || "PENDING"}${extra ? `\n\n${extra}` : ""}\n\nOpen Admin Inbox: ${process.env.PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "https://bookingnail.overpowers.agency"}/admin/inbox`;
  await Promise.all(recipients.map((recipient) => queueInternalEmail(tx, {
    recipient,
    event: "internal_staff_leave_alert",
    subject: `Nail Lounge leave alert: ${subject}`,
    message,
    bookingId: null,
  })));
}

export async function queueStaffLeaveEmail(tx: PrismaTx, leave: any, subject: string, extra = "") {
  const recipient = String(leave.staff?.email || "").trim().toLowerCase();
  if (!recipient || !recipient.includes("@")) return;
  const from = dayText(leave.startDate);
  const to = dayText(leave.endDate);
  const message = `${subject}\n\nYour leave ticket from ${from} to ${to} is now ${leave.status || "updated"}.\nReason: ${leave.reason || "-"}${leave.managerNote ? `\nManager note: ${leave.managerNote}` : ""}${extra ? `\n\n${extra}` : ""}\n\nOpen Staff Portal: ${process.env.PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "https://bookingnail.overpowers.agency"}/staff`;
  await queueInternalEmail(tx, {
    recipient,
    event: "internal_staff_leave_alert",
    subject: `Nail Lounge leave update: ${subject}`,
    message,
    bookingId: null,
  });
}
