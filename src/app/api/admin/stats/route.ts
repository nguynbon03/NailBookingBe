import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const [customers, bookings, revenue, services] = await Promise.all([
    prisma.user.count({ where: { role: "CUSTOMER" } }),
    prisma.booking.count(),
    prisma.revenue.aggregate({ _sum: { amount: true } }),
    prisma.service.count(),
  ]);
  return NextResponse.json({
    stats: { customers, bookings, revenue: revenue._sum.amount?.toNumber() || 0, services },
  });
}
