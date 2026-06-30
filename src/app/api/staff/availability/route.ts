import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, isAdminRole, isStaffPortalRole } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function dateOnly(value: string | Date) {
  const d = new Date(value);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function resolveStaffId(user: { email: string; role: string }, requested?: string | null) {
  if (isAdminRole(user.role) && requested) return requested;
  const staff = await prisma.staff.findFirst({ where: { email: user.email } });
  return staff?.id || null;
}

function payload(data: any, staffId: string) {
  const dayOfWeek = data.dayOfWeek === "" || data.dayOfWeek == null ? null : Number(data.dayOfWeek);
  return {
    staffId,
    dayOfWeek,
    date: data.date ? dateOnly(data.date) : null,
    startTime: String(data.startTime || "09:00"),
    endTime: String(data.endTime || "18:00"),
    active: data.active === undefined ? true : Boolean(data.active),
  };
}

export async function GET(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || !isStaffPortalRole(authUser.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const requested = req.nextUrl.searchParams.get("staffId");
  const staffId = await resolveStaffId(authUser, requested);
  if (!staffId) return NextResponse.json({ error: "Staff profile not found" }, { status: 403 });

  const availability = await prisma.staffAvailability.findMany({ where: { staffId }, orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }] });
  return NextResponse.json({ staffId, availability });
}

export async function POST(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || !isStaffPortalRole(authUser.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const staffId = await resolveStaffId(authUser, body.staffId ? String(body.staffId) : null);
  if (!staffId) return NextResponse.json({ error: "Staff profile not found" }, { status: 403 });

  const availability = await prisma.staffAvailability.create({ data: payload(body, staffId) });
  return NextResponse.json({ availability });
}

export async function PUT(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || !isStaffPortalRole(authUser.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  if (!body.id) return NextResponse.json({ error: "Availability id is required" }, { status: 400 });

  const staffId = await resolveStaffId(authUser, body.staffId ? String(body.staffId) : null);
  if (!staffId) return NextResponse.json({ error: "Staff profile not found" }, { status: 403 });

  const availability = await prisma.staffAvailability.update({ where: { id: String(body.id) }, data: payload(body, staffId) });
  return NextResponse.json({ availability });
}

export async function DELETE(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || !isStaffPortalRole(authUser.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await req.json().catch(() => ({}));
  if (!id) return NextResponse.json({ error: "Availability id is required" }, { status: 400 });

  await prisma.staffAvailability.delete({ where: { id: String(id) } });
  return NextResponse.json({ success: true });
}
