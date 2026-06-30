import { NextResponse } from "next/server";
import { BookingStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function money(value: unknown) {
  return Math.round(Number(value || 0) * 100) / 100;
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

function buildSeries(keys: string[], totals: Map<string, number>) {
  return keys.map((key) => ({ label: key, revenue: money(totals.get(key) || 0) }));
}

export async function GET() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear() - 3, 0, 1));
  const revenueStatuses: BookingStatus[] = ["CONFIRMED", "COMPLETED"];

  const [totalUsers, customers, adminUsers, bookings, confirmedBookings, services, activeServices, activePromoCodes, promoCodes] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { role: "CUSTOMER" } }),
    prisma.user.count({ where: { role: { in: ["ADMIN", "MANAGER", "STAFF"] } } }),
    prisma.booking.count(),
    prisma.booking.findMany({
      where: { status: { in: revenueStatuses }, date: { gte: start } },
      select: { id: true, date: true, totalPrice: true, discount: true, promoCode: true, status: true },
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
  let revenue = 0;

  for (const booking of confirmedBookings) {
    const amount = Number(booking.totalPrice);
    revenue += amount;
    dailyTotals.set(dateKey(booking.date), (dailyTotals.get(dateKey(booking.date)) || 0) + amount);
    monthlyTotals.set(monthKey(booking.date), (monthlyTotals.get(monthKey(booking.date)) || 0) + amount);
    yearlyTotals.set(yearKey(booking.date), (yearlyTotals.get(yearKey(booking.date)) || 0) + amount);
  }

  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayKeys = Array.from({ length: 14 }, (_, index) => dateKey(addDays(todayUtc, index - 13)));
  const firstMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthKeys = Array.from({ length: 12 }, (_, index) => monthKey(addMonths(firstMonth, index - 11)));
  const yearKeys = Array.from({ length: 4 }, (_, index) => String(now.getUTCFullYear() - 3 + index));

  return NextResponse.json({
    stats: {
      totalUsers,
      customers,
      adminUsers,
      bookings,
      confirmedBookings: confirmedBookings.length,
      pendingBookings: await prisma.booking.count({ where: { status: "PENDING" } }),
      revenue: money(revenue),
      services,
      activeServices,
      activePromoCodes,
    },
    revenueSeries: {
      daily: buildSeries(dayKeys, dailyTotals),
      monthly: buildSeries(monthKeys, monthlyTotals),
      yearly: buildSeries(yearKeys, yearlyTotals),
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
