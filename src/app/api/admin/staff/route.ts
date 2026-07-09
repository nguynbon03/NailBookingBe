import { NextRequest, NextResponse } from "next/server";
import { Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { getAuthUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_STAFF_PASSWORD = "staff123";
const serviceStaffRoles = new Set(["THERAPIST", "MANICURIST", "WAXING_SPECIALIST"]);

function normalizeStaffRole(value: unknown) {
  const role = String(value || "THERAPIST").trim().toUpperCase();
  return serviceStaffRoles.has(role) ? role : "THERAPIST";
}

function staffPayload(data: any) {
  return {
    name: String(data.name || "").trim(),
    email: String(data.email || "").trim().toLowerCase(),
    phone: data.phone ? String(data.phone) : null,
    role: normalizeStaffRole(data.role),
    bio: data.bio ? String(data.bio) : null,
    avatar: data.avatar ? String(data.avatar) : null,
    active: data.active === undefined ? true : Boolean(data.active),
  };
}

function loginRoleFromStaffRole(_staffRole: string): Role {
  return "STAFF";
}

function canManageLoginRole(actorRole: string, targetRole: Role, currentRole?: Role | null) {
  if (actorRole === "ADMIN") return true;
  return targetRole === "STAFF" && !["ADMIN", "MANAGER"].includes(currentRole || "");
}

function forbiddenRoleResponse() {
  return NextResponse.json({ error: "Only ADMIN can create, edit, promote, demote, or reset ADMIN/MANAGER login roles" }, { status: 403 });
}

async function assertCanManageStaffLogin(req: NextRequest, email: string, targetRole: Role) {
  const actor = await getAuthUser(req);
  if (!actor || !["ADMIN", "MANAGER"].includes(actor.role)) {
    return { ok: false as const, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  const existingLogin = email ? await prisma.user.findUnique({ where: { email }, select: { role: true } }) : null;
  if (!canManageLoginRole(actor.role, targetRole, existingLogin?.role || null)) {
    return { ok: false as const, response: forbiddenRoleResponse() };
  }
  return { ok: true as const, actor };
}

async function upsertStaffLogin(data: { name: string; email: string; phone: string | null; role: string }, password?: string) {
  if (!data.email) return;
  const loginRole = loginRoleFromStaffRole(data.role);
  const updateData = { name: data.name, phone: data.phone, role: loginRole, emailVerifiedAt: new Date() };
  const existing = await prisma.user.findUnique({ where: { email: data.email } });
  if (existing) {
    await prisma.user.update({ where: { email: data.email }, data: updateData });
    if (password) {
      await prisma.user.update({ where: { email: data.email }, data: { password: await bcrypt.hash(password, 10) } });
    }
    return;
  }

  await prisma.user.create({
    data: {
      email: data.email,
      name: data.name,
      phone: data.phone,
      role: loginRole,
      password: await bcrypt.hash(password || DEFAULT_STAFF_PASSWORD, 10),
      emailVerifiedAt: new Date(),
    },
  });
}

export async function GET() {
  const [staff, groupedRatings, latestReviews] = await Promise.all([
    prisma.staff.findMany({ orderBy: { name: "asc" } }),
    prisma.staffReview.groupBy({ by: ["staffId"], _avg: { rating: true }, _count: { rating: true } }),
    prisma.staffReview.findMany({
      where: { publicComment: true, comment: { not: null } },
      orderBy: { createdAt: "desc" },
      distinct: ["staffId"],
      select: { staffId: true, rating: true, comment: true, createdAt: true },
    }),
  ]);
  const ratingByStaff = new Map(groupedRatings.map((item) => [item.staffId, item]));
  const latestByStaff = new Map(latestReviews.map((item) => [item.staffId, item]));
  return NextResponse.json({
    staff: staff.map((item) => {
      const rating = ratingByStaff.get(item.id);
      const latestReview = latestByStaff.get(item.id);
      return {
        ...item,
        ratingAverage: rating?._avg.rating ? Number(rating._avg.rating.toFixed(2)) : null,
        ratingCount: rating?._count.rating || 0,
        latestReview: latestReview ? { rating: latestReview.rating, comment: latestReview.comment, createdAt: latestReview.createdAt } : null,
      };
    }),
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const data = staffPayload(body);
    if (!data.name || !data.email) return NextResponse.json({ error: "Staff name and email are required" }, { status: 400 });

    const targetLoginRole = loginRoleFromStaffRole(data.role);
    const permission = await assertCanManageStaffLogin(req, data.email, targetLoginRole);
    if (!permission.ok) return permission.response;

    const staff = await prisma.staff.create({ data });
    await upsertStaffLogin(data, body.loginPassword ? String(body.loginPassword) : undefined);
    return NextResponse.json({ staff });
  } catch (e: any) {
    const message = e?.code === "P2002" ? "Staff email already exists" : "Failed to create staff";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const { id } = body;
    if (!id) return NextResponse.json({ error: "Staff id is required" }, { status: 400 });

    const data = staffPayload(body);
    if (!data.name || !data.email) return NextResponse.json({ error: "Staff name and email are required" }, { status: 400 });

    const existingStaff = await prisma.staff.findUnique({ where: { id: String(id) } });
    if (!existingStaff) return NextResponse.json({ error: "Staff not found" }, { status: 404 });

    const targetLoginRole = loginRoleFromStaffRole(data.role);
    const permission = await assertCanManageStaffLogin(req, data.email, targetLoginRole);
    if (!permission.ok) return permission.response;

    if (existingStaff.email !== data.email) {
      const oldLogin = await prisma.user.findUnique({ where: { email: existingStaff.email }, select: { role: true } });
      if (!canManageLoginRole(permission.actor.role, "STAFF", oldLogin?.role || null)) return forbiddenRoleResponse();
    }

    const staff = await prisma.staff.update({ where: { id: String(id) }, data });
    await upsertStaffLogin(data, body.loginPassword ? String(body.loginPassword) : undefined);
    return NextResponse.json({ staff });
  } catch (e: any) {
    const message = e?.code === "P2002" ? "Staff email already exists" : "Failed to update staff";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const actor = await getAuthUser(req);
    if (!actor || !["ADMIN", "MANAGER"].includes(actor.role)) {
      return NextResponse.json({ error: "Only ADMIN/MANAGER can delete staff records" }, { status: 403 });
    }
    const { id } = await req.json();
    await prisma.staff.delete({ where: { id: String(id) } });
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: "Failed to delete staff" }, { status: 500 });
  }
}
