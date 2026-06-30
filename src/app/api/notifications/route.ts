import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, isAdminRole } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function resolveStaffId(email: string) {
  const staff = await prisma.staff.findFirst({ where: { email } });
  return staff?.id || null;
}

export async function GET(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const audienceParam = req.nextUrl.searchParams.get("audience");
  const take = Number(req.nextUrl.searchParams.get("take") || 20);
  const where: any = {};

  if (audienceParam === "staff" || authUser.role === "STAFF") {
    const staffId = await resolveStaffId(authUser.email);
    where.audience = "STAFF";
    if (staffId) where.OR = [{ staffId }, { staffId: null }];
  } else if (isAdminRole(authUser.role)) {
    where.audience = "ADMIN";
  } else {
    where.userId = authUser.id;
  }

  const [notifications, unread] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: "desc" }, take: Math.min(100, Math.max(1, take)) }),
    prisma.notification.count({ where: { ...where, read: false } }),
  ]);

  return NextResponse.json({ notifications, unread });
}

export async function PUT(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, read = true, audience } = await req.json().catch(() => ({}));
  if (!id && !audience) return NextResponse.json({ error: "notification id or audience is required" }, { status: 400 });

  if (id) {
    const notification = await prisma.notification.update({ where: { id: String(id) }, data: { read: Boolean(read) } });
    return NextResponse.json({ notification });
  }

  if (audience === "staff") {
    const staffId = await resolveStaffId(authUser.email);
    await prisma.notification.updateMany({ where: { audience: "STAFF", OR: [{ staffId }, { staffId: null }] }, data: { read: Boolean(read) } });
  } else if (isAdminRole(authUser.role)) {
    await prisma.notification.updateMany({ where: { audience: "ADMIN" }, data: { read: Boolean(read) } });
  }

  return NextResponse.json({ success: true });
}
