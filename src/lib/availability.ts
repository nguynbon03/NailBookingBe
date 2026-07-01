import { PrismaClient } from "@prisma/client";
import { isStaffSlotLocked } from "@/lib/payment-locks";

type PrismaTx = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export type Slot = {
  time: string;
  availableStaffCount: number;
  staffIds: string[];
};

export function timeToMinutes(value: string) {
  const [h, m] = String(value || "").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function minutesToTime(value: number) {
  const h = Math.floor(value / 60).toString().padStart(2, "0");
  const m = (value % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

function dateOnly(value: string | Date) {
  const d = new Date(value);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function dayOfWeek(value: Date) {
  return value.getUTCDay();
}

async function getStaffWindows(tx: PrismaTx, staffId: string, date: Date) {
  const exactDate = dateOnly(date);
  const dow = dayOfWeek(exactDate);
  const rows = await tx.staffAvailability.findMany({
    where: {
      staffId,
      active: true,
      OR: [{ date: exactDate }, { date: null, dayOfWeek: dow }],
    },
    orderBy: [{ date: "desc" }, { startTime: "asc" }],
  });
  return rows;
}

function bookingDuration(booking: any) {
  const total = (booking.services || []).reduce((sum: number, item: any) => sum + Number(item.service?.duration || 0), 0);
  return total || 30;
}

function overlaps(aStart: number, aDuration: number, bStart: number, bDuration: number) {
  return aStart < bStart + bDuration && bStart < aStart + aDuration;
}

async function staffHasBookingAt(tx: PrismaTx, staffId: string, date: Date, time: string, duration = 30, ignoreBookingId?: string) {
  const requestedStart = timeToMinutes(time);
  const bookings = await tx.booking.findMany({
    where: {
      date: dateOnly(date),
      archivedAt: null,
      ...(ignoreBookingId ? { id: { not: ignoreBookingId } } : {}),
      AND: [
        { OR: [{ staffId }, { requestedStaffId: staffId }] },
        { OR: [{ status: "CONFIRMED" }, { status: "PENDING", depositRequired: false }] },
      ],
    },
    include: { services: { include: { service: true } } },
  });
  return bookings.some((booking: any) => overlaps(requestedStart, duration, timeToMinutes(booking.time), bookingDuration(booking)));
}

async function staffHasApprovedLeave(tx: PrismaTx, staffId: string, date: Date) {
  const leaveModel = (tx as any).staffLeaveRequest;
  if (!leaveModel) return false;
  const requestedDate = dateOnly(date);
  const leave = await leaveModel.findFirst({
    where: {
      staffId,
      status: "APPROVED",
      startDate: { lte: requestedDate },
      endDate: { gte: requestedDate },
    },
    select: { id: true },
  });
  return Boolean(leave);
}

async function capacityBlockingAt(tx: PrismaTx, date: Date, time: string, duration = 30) {
  const requestedStart = timeToMinutes(time);
  const bookings = await tx.booking.findMany({
    where: {
      date: dateOnly(date),
      archivedAt: null,
      OR: [
        { status: "CONFIRMED" },
        { status: "PENDING", depositRequired: false },
      ],
    },
    include: { services: { include: { service: true } } },
  });

  // Cinema-seat logic:
  // - A normal assigned booking already removes 1 specific staff from availableStaffIdsAt().
  // - An assigned group booking consumes (numPeople - 1) extra floating capacity.
  // - An unassigned group booking consumes all numPeople floating capacity.
  return bookings
    .filter((booking: any) => overlaps(requestedStart, duration, timeToMinutes(booking.time), bookingDuration(booking)))
    .reduce((sum: number, booking: any) => {
      const people = Math.max(1, Number(booking.numPeople || 1));
      const hasSpecificStaff = Boolean(booking.staffId || booking.requestedStaffId);
      return sum + (hasSpecificStaff ? Math.max(0, people - 1) : people);
    }, 0);
}

export async function isStaffAvailableAndFree(tx: PrismaTx, staffId: string, dateInput: string | Date, time: string, duration = 30, ignoreBookingId?: string) {
  const date = dateOnly(dateInput);
  const staff = await tx.staff.findFirst({ where: { id: staffId, active: true, role: { notIn: ["ADMIN", "MANAGER"] } }, select: { id: true } });
  if (!staff) return false;
  if (await staffHasApprovedLeave(tx, staffId, date)) return false;

  const start = timeToMinutes(time);
  const end = start + duration;
  const windows = await getStaffWindows(tx, staffId, date);
  const inWindow = windows.some((window) => start >= timeToMinutes(window.startTime) && end <= timeToMinutes(window.endTime));
  if (!inWindow) return false;

  const busy = await staffHasBookingAt(tx, staffId, date, time, duration, ignoreBookingId);
  if (busy) return false;
  if (await isStaffSlotLocked(tx, staffId, date, time, ignoreBookingId)) return false;
  return true;
}

export async function availableStaffIdsAt(tx: PrismaTx, dateInput: string | Date, time: string, duration = 30, staffId?: string | null) {
  const date = dateOnly(dateInput);
  const staff = await tx.staff.findMany({
    where: { active: true, role: { notIn: ["ADMIN", "MANAGER"] }, ...(staffId ? { id: staffId } : {}) },
    select: { id: true },
  });
  const free: string[] = [];
  for (const item of staff) {
    if (await isStaffAvailableAndFree(tx, item.id, date, time, duration)) free.push(item.id);
  }
  return free;
}

export async function availableCapacityAt(tx: PrismaTx, dateInput: string | Date, time: string, duration = 30, staffId?: string | null) {
  const date = dateOnly(dateInput);
  const free = await availableStaffIdsAt(tx, date, time, duration, staffId || null);
  if (staffId) return free.length; // specific staff can only take one person at that time
  const pendingPeople = await capacityBlockingAt(tx, date, time, duration);
  return Math.max(0, free.length - pendingPeople);
}

export async function hasAnyAvailableStaff(tx: PrismaTx, dateInput: string | Date, time: string, duration = 30) {
  return (await availableCapacityAt(tx, dateInput, time, duration)) > 0;
}

export async function buildAvailabilitySlots(tx: PrismaTx, dateInput: string | Date, duration = 30, staffId?: string | null) {
  const date = dateOnly(dateInput);
  const staff = await tx.staff.findMany({
    where: { active: true, role: { notIn: ["ADMIN", "MANAGER"] }, ...(staffId ? { id: staffId } : {}) },
    select: { id: true, name: true },
  });
  const slotMap = new Map<string, Set<string>>();

  for (const item of staff) {
    const windows = await getStaffWindows(tx, item.id, date);
    for (const window of windows) {
      const start = timeToMinutes(window.startTime);
      const end = timeToMinutes(window.endTime);
      for (let current = start; current + duration <= end; current += 30) {
        const time = minutesToTime(current);
        if (await isStaffAvailableAndFree(tx, item.id, date, time, duration)) {
          if (!slotMap.has(time)) slotMap.set(time, new Set());
          slotMap.get(time)!.add(item.id);
        }
      }
    }
  }

  const slots: Slot[] = [];
  for (const [time, ids] of Array.from(slotMap.entries())) {
    let availableStaffCount = ids.size;
    if (!staffId) {
      availableStaffCount = Math.max(0, availableStaffCount - (await capacityBlockingAt(tx, date, time, duration)));
    }
    if (availableStaffCount > 0) {
      slots.push({ time, availableStaffCount, staffIds: Array.from(ids) });
    }
  }

  return slots.sort((a, b) => a.time.localeCompare(b.time));
}
