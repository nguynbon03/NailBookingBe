import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, isStaffPortalRole } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STAFF_SOURCE = "STAFF_PORTAL";

function dateOnly(value: string | Date) {
  const d = new Date(value);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function validTime(value: unknown) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
}

function minutes(value: string) {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

async function resolveOwnStaffId(user: { email: string }) {
  const staff = await prisma.staff.findFirst({ where: { email: user.email, active: true }, select: { id: true } });
  return staff?.id || null;
}

function payload(data: any, staffId: string) {
  const startTime = String(data.startTime || "").trim();
  const endTime = String(data.endTime || "").trim();
  if (!validTime(startTime) || !validTime(endTime)) throw new Error("Start and end time are required");
  if (minutes(startTime) >= minutes(endTime)) throw new Error("End time must be after start time");

  const hasSpecificDate = Boolean(data.date);
  const dayOfWeek = hasSpecificDate || data.dayOfWeek === "" || data.dayOfWeek == null ? null : Number(data.dayOfWeek);
  if (!hasSpecificDate && (!Number.isInteger(dayOfWeek) || dayOfWeek! < 0 || dayOfWeek! > 6)) {
    throw new Error("Select either a weekday or a specific date");
  }

  return {
    staffId,
    dayOfWeek,
    date: hasSpecificDate ? dateOnly(data.date) : null,
    startTime,
    endTime,
    active: data.active === undefined ? true : Boolean(data.active),
    createdBySource: STAFF_SOURCE,
  };
}

export async function GET(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || !isStaffPortalRole(authUser.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const staffId = await resolveOwnStaffId(authUser);
  if (!staffId) return NextResponse.json({ error: "Staff profile not found. Working hours must be added by the staff account assigned to that staff profile." }, { status: 403 });

  const availability = await prisma.staffAvailability.findMany({
    where: { staffId, createdBySource: STAFF_SOURCE },
    orderBy: [{ date: "asc" }, { dayOfWeek: "asc" }, { startTime: "asc" }],
  });
  return NextResponse.json({ staffId, availability });
}

export async function POST(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || !isStaffPortalRole(authUser.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const staffId = await resolveOwnStaffId(authUser);
  if (!staffId) return NextResponse.json({ error: "Staff profile not found. Working hours must be added by the staff account assigned to that staff profile." }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  try {
    const next = payload(body, staffId);
    const existing = await prisma.staffAvailability.findFirst({
      where: {
        staffId,
        createdBySource: STAFF_SOURCE,
        dayOfWeek: next.dayOfWeek,
        date: next.date,
        startTime: next.startTime,
        endTime: next.endTime,
      },
    });
    if (existing) return NextResponse.json({ availability: existing, deduped: true });
    const availability = await prisma.staffAvailability.create({ data: next });
    return NextResponse.json({ availability });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save availability" }, { status: 400 });
  }
}

export async function PUT(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || !isStaffPortalRole(authUser.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  if (!body.id) return NextResponse.json({ error: "Availability id is required" }, { status: 400 });

  const staffId = await resolveOwnStaffId(authUser);
  if (!staffId) return NextResponse.json({ error: "Staff profile not found" }, { status: 403 });

  const existing = await prisma.staffAvailability.findFirst({ where: { id: String(body.id), staffId, createdBySource: STAFF_SOURCE }, select: { id: true } });
  if (!existing) return NextResponse.json({ error: "Availability slot not found for this staff account" }, { status: 404 });

  try {
    const availability = await prisma.staffAvailability.update({ where: { id: existing.id }, data: payload(body, staffId) });
    return NextResponse.json({ availability });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not update availability" }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || !isStaffPortalRole(authUser.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await req.json().catch(() => ({}));
  if (!id) return NextResponse.json({ error: "Availability id is required" }, { status: 400 });

  const staffId = await resolveOwnStaffId(authUser);
  if (!staffId) return NextResponse.json({ error: "Staff profile not found" }, { status: 403 });

  const existing = await prisma.staffAvailability.findFirst({ where: { id: String(id), staffId, createdBySource: STAFF_SOURCE }, select: { id: true } });
  if (!existing) return NextResponse.json({ error: "Availability slot not found for this staff account" }, { status: 404 });

  await prisma.staffAvailability.delete({ where: { id: existing.id } });
  return NextResponse.json({ success: true });
}
