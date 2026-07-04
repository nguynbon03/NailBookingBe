import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, isAdminRole } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ADMIN_TICKET_TYPES = [
  "CUSTOMER_CANCEL_REQUEST",
  "CUSTOMER_CANCELLED_PENDING_BOOKING",
  "STAFF_LEAVE_REQUESTED",
  "STAFF_LEAVE_CANCELLED",
  "STAFF_REJECTED_JOB",
];

function applyNotificationCategory(where: any, category?: string | null) {
  if (category === "tickets") where.type = { in: ADMIN_TICKET_TYPES };
  return where;
}

async function resolveStaffId(email: string) {
  const staff = await prisma.staff.findFirst({ where: { email } });
  return staff?.id || null;
}

function staffOnlyScope(staffId: string | null) {
  return { audience: "STAFF", staffId: staffId || "__NO_STAFF_SCOPE__" };
}

async function notificationScope(req: NextRequest, authUser: any) {
  const audience = req.nextUrl.searchParams.get("audience");
  const where: any = {};

  if (audience === "customer") {
    return { audience: "CUSTOMER", userId: authUser.id };
  }

  if (audience === "staff" || authUser.role === "STAFF") {
    const staffId = await resolveStaffId(authUser.email);
    return staffOnlyScope(staffId);
  }

  if (isAdminRole(authUser.role)) {
    where.audience = "ADMIN";
    return where;
  }

  where.audience = "CUSTOMER";
  where.userId = authUser.id;
  return where;
}

async function scopedWhereFromBody(req: NextRequest, authUser: any, body: any) {
  if (body?.audience === "customer") {
    return { audience: "CUSTOMER", userId: authUser.id };
  }
  if (body?.audience === "staff" || authUser.role === "STAFF") {
    const staffId = await resolveStaffId(authUser.email);
    return staffOnlyScope(staffId);
  }
  if (isAdminRole(authUser.role)) return { audience: "ADMIN" };
  return { audience: "CUSTOMER", userId: authUser.id };
}

export async function GET(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const take = Number(req.nextUrl.searchParams.get("take") || 50);
  const unreadOnly = req.nextUrl.searchParams.get("unread") === "1";
  const category = req.nextUrl.searchParams.get("category");
  const where = applyNotificationCategory(await notificationScope(req, authUser), category);
  if (unreadOnly) where.read = false;

  const [notifications, unread] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: "desc" }, take: Math.min(200, Math.max(1, take)) }),
    prisma.notification.count({ where: { ...where, read: false } }),
  ]);

  return NextResponse.json({ notifications, unread });
}

export async function PUT(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const id = body?.id ? String(body.id) : "";
  const read = body?.read !== false;
  const scope = applyNotificationCategory(await scopedWhereFromBody(req, authUser, body), body?.category ? String(body.category) : null);

  if (id) {
    const existing = await prisma.notification.findFirst({ where: { ...scope, id } });
    if (!existing) return NextResponse.json({ error: "Notification not found" }, { status: 404 });
    const notification = await prisma.notification.update({ where: { id }, data: { read } });
    return NextResponse.json({ notification });
  }

  await prisma.notification.updateMany({ where: scope, data: { read } });
  return NextResponse.json({ success: true });
}

export async function DELETE(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const id = body?.id ? String(body.id) : "";
  const ids = Array.isArray(body?.ids) ? body.ids.map((value: unknown) => String(value || "").trim()).filter(Boolean) : [];
  const scope = applyNotificationCategory(await scopedWhereFromBody(req, authUser, body), body?.category ? String(body.category) : null);

  if (id) {
    const existing = await prisma.notification.findFirst({ where: { ...scope, id } });
    if (!existing) return NextResponse.json({ error: "Notification not found" }, { status: 404 });
    await prisma.notification.delete({ where: { id } });
    return NextResponse.json({ success: true, deleted: 1 });
  }

  if (ids.length) {
    const result = await prisma.notification.deleteMany({ where: { ...scope, id: { in: ids } } });
    return NextResponse.json({ success: true, deleted: result.count });
  }

  const olderThan = body?.olderThan ? new Date(String(body.olderThan)) : null;
  const where: any = { ...scope };
  if (olderThan && !Number.isNaN(olderThan.getTime())) where.createdAt = { lt: olderThan };
  if (body?.readOnly !== false) where.read = true;
  const result = await prisma.notification.deleteMany({ where });
  return NextResponse.json({ success: true, deleted: result.count });
}
