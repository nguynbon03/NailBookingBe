import { NextRequest, NextResponse } from "next/server";
import { BookingStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAuthUser, isAdminRole } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Granularity = "daily" | "monthly" | "yearly";

function money(value: unknown) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addMonths(date: Date, months: number) {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function monthKey(date: Date) {
  return date.toISOString().slice(0, 7);
}

function yearKey(date: Date) {
  return String(date.getUTCFullYear());
}

function parseDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return startOfUtcDay(date);
}

function describeRange(start: Date, endExclusive: Date) {
  return `${dateKey(start)} to ${dateKey(addDays(endExclusive, -1))}`;
}

function resolveFilters(req: NextRequest) {
  const search = req.nextUrl.searchParams;
  const granularity = (search.get("granularity") === "monthly" || search.get("granularity") === "yearly")
    ? (search.get("granularity") as Granularity)
    : "daily";

  const today = startOfUtcDay(new Date());
  const defaultStart = addDays(today, -13);
  const endInclusive = addDays(today, 1); // include today's bookings
  const rawFrom = parseDate(search.get("fromDate")) || defaultStart;
  const rawTo = parseDate(search.get("toDate")) || endInclusive;
  const safeStart = rawFrom <= rawTo ? rawFrom : rawTo;
  const safeTo = rawFrom <= rawTo ? rawTo : rawFrom;
  const endExclusive = addDays(safeTo, 1);

  return {
    granularity,
    start: safeStart,
    endExclusive,
    fromDate: dateKey(safeStart),
    toDate: dateKey(safeTo),
    label: describeRange(safeStart, endExclusive),
  };
}

function buildKeys(granularity: Granularity, start: Date, endExclusive: Date) {
  if (granularity === "yearly") {
    const keys: string[] = [];
    for (let year = start.getUTCFullYear(); year <= addDays(endExclusive, -1).getUTCFullYear(); year += 1) keys.push(String(year));
    return keys;
  }

  if (granularity === "monthly") {
    const keys: string[] = [];
    let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    while (cursor < endExclusive) {
      keys.push(monthKey(cursor));
      cursor = addMonths(cursor, 1);
    }
    return keys;
  }

  const keys: string[] = [];
  let cursor = new Date(start);
  while (cursor < endExclusive) {
    keys.push(dateKey(cursor));
    cursor = addDays(cursor, 1);
  }
  return keys;
}

function buildSeries(keys: string[], revenueTotals: Map<string, number>, countTotals: Map<string, number>) {
  return keys.map((key) => ({
    label: key,
    revenue: money(revenueTotals.get(key) || 0),
    count: countTotals.get(key) || 0,
  }));
}

export async function GET(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || !isAdminRole(authUser.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const filters = resolveFilters(req);
  const revenueStatuses: BookingStatus[] = ["CONFIRMED", "COMPLETED"];
  const activeBookingWhere = {
    archivedAt: null,
    date: { gte: filters.start, lt: filters.endExclusive },
  } as const;

  const [totalUsers, customers, adminUsers, bookings, pendingBookings, cancelledBookings, allBookingsForSeries, confirmedBookings, services, activeServices, activePromoCodes, promoCodes] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { role: "CUSTOMER" } }),
    prisma.user.count({ where: { role: { in: ["ADMIN", "MANAGER", "STAFF"] } } }),
    prisma.booking.count({ where: activeBookingWhere }),
    prisma.booking.count({ where: { ...activeBookingWhere, status: "PENDING" } }),
    prisma.booking.count({ where: { ...activeBookingWhere, status: "CANCELLED" } }),
    prisma.booking.findMany({
      where: activeBookingWhere,
      select: { id: true, date: true, status: true },
      orderBy: { date: "asc" },
    }),
    prisma.booking.findMany({
      where: { ...activeBookingWhere, status: { in: revenueStatuses } },
      select: { id: true, date: true, totalPrice: true, status: true },
      orderBy: { date: "asc" },
    }),
    prisma.service.count(),
    prisma.service.count({ where: { active: true } }),
    prisma.promoCode.count({ where: { active: true } }),
    prisma.promoCode.findMany({ orderBy: { usedCount: "desc" }, take: 8 }),
  ]);

  const dailyTotals = new Map<string, number>();
  const monthlyTotals = new Map<string, number>();
  const yearlyTotals = new Map<string, number>();
  const dailyCounts = new Map<string, number>();
  const monthlyCounts = new Map<string, number>();
  const yearlyCounts = new Map<string, number>();
  let revenue = 0;

  for (const booking of allBookingsForSeries) {
    dailyCounts.set(dateKey(booking.date), (dailyCounts.get(dateKey(booking.date)) || 0) + 1);
    monthlyCounts.set(monthKey(booking.date), (monthlyCounts.get(monthKey(booking.date)) || 0) + 1);
    yearlyCounts.set(yearKey(booking.date), (yearlyCounts.get(yearKey(booking.date)) || 0) + 1);
  }

  for (const booking of confirmedBookings) {
    const amount = Number(booking.totalPrice || 0);
    revenue += amount;
    dailyTotals.set(dateKey(booking.date), (dailyTotals.get(dateKey(booking.date)) || 0) + amount);
    monthlyTotals.set(monthKey(booking.date), (monthlyTotals.get(monthKey(booking.date)) || 0) + amount);
    yearlyTotals.set(yearKey(booking.date), (yearlyTotals.get(yearKey(booking.date)) || 0) + amount);
  }

  const dayKeys = buildKeys("daily", filters.start, filters.endExclusive);
  const monthKeys = buildKeys("monthly", filters.start, filters.endExclusive);
  const yearKeys = buildKeys("yearly", filters.start, filters.endExclusive);

  return NextResponse.json({
    filters,
    stats: {
      totalUsers,
      customers,
      adminUsers,
      bookings,
      confirmedBookings: confirmedBookings.length,
      pendingBookings,
      cancelledBookings,
      revenue: money(revenue),
      services,
      activeServices,
      activePromoCodes,
    },
    revenueSeries: {
      daily: buildSeries(dayKeys, dailyTotals, dailyCounts),
      monthly: buildSeries(monthKeys, monthlyTotals, monthlyCounts),
      yearly: buildSeries(yearKeys, yearlyTotals, yearlyCounts),
    },
    promoCodes: promoCodes.map((promo) => ({
      id: promo.id,
      code: promo.code,
      name: promo.name,
      discountPercent: promo.discountPercent,
      active: promo.active,
      usageLimit: promo.usageLimit,
      usedCount: promo.usedCount,
      remaining: promo.usageLimit == null ? null : Math.max(0, promo.usageLimit - promo.usedCount),
    })),
  });
}
