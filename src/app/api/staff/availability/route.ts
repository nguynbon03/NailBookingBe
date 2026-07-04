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

function normalizeReplaceWeekSlots(items: any[], staffId: string) {
  const normalized = items.map((item) => payload(item, staffId));
  const byDate = new Map<string, { startTime: string; endTime: string }[]>();
  for (const item of normalized) {
    if (!item.date) throw new Error("Weekly slots must use specific dates");
    const key = item.date.toISOString().slice(0, 10);
    const bucket = byDate.get(key) || [];
    bucket.push({ startTime: item.startTime, endTime: item.endTime });
    byDate.set(key, bucket);
  }
  for (const ranges of byDate.values()) {
    const ordered = ranges.slice().sort((a, b) => minutes(a.startTime) - minutes(b.startTime));
    for (let index = 1; index < ordered.length; index += 1) {
      if (minutes(ordered[index].startTime) < minutes(ordered[index - 1].endTime)) {
        throw new Error("Time slots on the same day cannot overlap");
      }
    }
  }
  return normalized;
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
    if (body?.replaceWeek === true) {
      const weekStart = String(body.weekStart || "").trim();
      const weekEnd = String(body.weekEnd || "").trim();
      if (!weekStart || !weekEnd) throw new Error("Week start and week end are required");
      const slots = normalizeReplaceWeekSlots(Array.isArray(body.slots) ? body.slots : [], staffId);
      const start = dateOnly(weekStart);
      const end = dateOnly(weekEnd);
      await prisma.$transaction(async (tx) => {
        await tx.staffAvailability.deleteMany({
          where: {
            staffId,
            createdBySource: STAFF_SOURCE,
            date: { gte: start, lte: end },
          },
        });
        if (slots.length) {
          await tx.staffAvailability.createMany({ data: slots });
        }
      });
      const availability = await prisma.staffAvailability.findMany({
        where: { staffId, createdBySource: STAFF_SOURCE },
        orderBy: [{ date: "asc" }, { dayOfWeek: "asc" }, { startTime: "asc" }],
      });
      return NextResponse.json({ availability, replacedWeek: true });
    }

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
