import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAuthUser, isAdminRole } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROLE_VALUES = new Set<Role>(["ADMIN", "MANAGER", "STAFF", "CUSTOMER"]);

function canManageAccounts(role?: string | null) {
  return isAdminRole(role);
}

function normalizeRole(value: unknown): Role | null {
  const role = String(value || "").trim().toUpperCase() as Role;
  return ROLE_VALUES.has(role) ? role : null;
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
    actor: { id: authUser.id, role: authUser.role },
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
  const newPassword = body.newPassword == null ? "" : String(body.newPassword || "");
  const requestedRole = body.role == null ? null : normalizeRole(body.role);
  if (!id) return NextResponse.json({ error: "Account id is required" }, { status: 400 });
  if (body.role != null && !requestedRole) return NextResponse.json({ error: "Invalid account role" }, { status: 400 });
  if (newPassword && newPassword.length < 6) return NextResponse.json({ error: "Password must be at least 6 characters" }, { status: 400 });
  if (!newPassword && !requestedRole) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });

  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, email: true, name: true } });
  if (!target) return NextResponse.json({ error: "Account not found" }, { status: 404 });

  if (target.role === "ADMIN" && authUser.role !== "ADMIN") {
    return NextResponse.json({ error: "Manager cannot edit ADMIN accounts" }, { status: 403 });
  }
  if (requestedRole === "ADMIN" && authUser.role !== "ADMIN") {
    return NextResponse.json({ error: "Only ADMIN can promote accounts to ADMIN" }, { status: 403 });
  }

  if (requestedRole && target.role === "ADMIN" && requestedRole !== "ADMIN") {
    const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
    if (adminCount <= 1) return NextResponse.json({ error: "Cannot demote the last ADMIN account" }, { status: 409 });
  }

  const data: { password?: string; role?: Role } = {};
  if (newPassword) data.password = await bcrypt.hash(newPassword, 10);
  if (requestedRole) data.role = requestedRole;

  const account = await prisma.user.update({
    where: { id },
    data,
    select: { id: true, email: true, name: true, role: true, phone: true, updatedAt: true },
  });

  return NextResponse.json({
    account,
    message: [newPassword ? "password" : "", requestedRole ? `role=${requestedRole}` : ""].filter(Boolean).join(" + ") + ` updated for ${account.email}`,
  });
}

export async function DELETE(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || !canManageAccounts(authUser.role)) {
    return NextResponse.json({ error: "Only ADMIN/MANAGER can delete accounts" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const id = String(body.id || "");
  if (!id) return NextResponse.json({ error: "Account id is required" }, { status: 400 });
  if (id === authUser.id) return NextResponse.json({ error: "You cannot delete your own account" }, { status: 400 });

  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true, name: true, role: true } });
  if (!target) return NextResponse.json({ error: "Account not found" }, { status: 404 });

  if (target.role === "ADMIN") {
    if (authUser.role === "MANAGER") {
      return NextResponse.json({ error: "Manager cannot delete ADMIN accounts" }, { status: 403 });
    }
    const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
    if (adminCount <= 1) return NextResponse.json({ error: "Cannot delete the last ADMIN account" }, { status: 409 });
  }

  await prisma.$transaction(async (tx) => {
    await tx.booking.updateMany({ where: { userId: id }, data: { userId: null } });
    await tx.user.delete({ where: { id } });
  });

  return NextResponse.json({ success: true, deleted: true, account: target });
}
