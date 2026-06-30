import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { getAuthUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function canManageAccounts(role?: string | null) {
  return role === "ADMIN" || role === "MANAGER";
}

function canResetTarget(actorRole: string, targetRole: string) {
  if (actorRole === "ADMIN") return true;
  return targetRole !== "ADMIN" && targetRole !== "MANAGER";
}

export async function GET(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || !canManageAccounts(authUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [users, staff] = await Promise.all([
    prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      select: { id: true, email: true, name: true, role: true, phone: true, avatar: true, createdAt: true, updatedAt: true },
    }),
    prisma.staff.findMany({ select: { id: true, email: true, name: true, role: true, active: true } }),
  ]);

  const staffByEmail = new Map(staff.map((item) => [item.email.toLowerCase(), item]));
  return NextResponse.json({
    accounts: users.map((user) => ({
      ...user,
      staffProfile: staffByEmail.get(user.email.toLowerCase()) || null,
    })),
  });
}

export async function PUT(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || !canManageAccounts(authUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const id = String(body.id || "");
  const newPassword = String(body.newPassword || "");
  if (!id) return NextResponse.json({ error: "Account id is required" }, { status: 400 });
  if (newPassword.length < 6) return NextResponse.json({ error: "Password must be at least 6 characters" }, { status: 400 });

  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, email: true, name: true } });
  if (!target) return NextResponse.json({ error: "Account not found" }, { status: 404 });
  if (!canResetTarget(authUser.role, target.role)) {
    return NextResponse.json({ error: "Only ADMIN can reset admin/manager accounts" }, { status: 403 });
  }

  const password = await bcrypt.hash(newPassword, 10);
  const account = await prisma.user.update({
    where: { id },
    data: { password },
    select: { id: true, email: true, name: true, role: true, phone: true, updatedAt: true },
  });

  return NextResponse.json({ account, message: `Password reset for ${account.email}` });
}

export async function DELETE(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || authUser.role !== "ADMIN") {
    return NextResponse.json({ error: "Only ADMIN can delete accounts" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const id = String(body.id || "");
  if (!id) return NextResponse.json({ error: "Account id is required" }, { status: 400 });
  if (id === authUser.id) return NextResponse.json({ error: "You cannot delete your own account" }, { status: 400 });

  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true, name: true, role: true } });
  if (!target) return NextResponse.json({ error: "Account not found" }, { status: 404 });

  if (target.role === "ADMIN") {
    const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
    if (adminCount <= 1) return NextResponse.json({ error: "Cannot delete the last ADMIN account" }, { status: 409 });
  }

  await prisma.$transaction(async (tx) => {
    await tx.booking.updateMany({ where: { userId: id }, data: { userId: null } });
    await tx.user.delete({ where: { id } });
  });

  return NextResponse.json({ success: true, deleted: true, account: target });
}
