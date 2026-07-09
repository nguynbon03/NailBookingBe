import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const [staff, groupedRatings] = await Promise.all([
    prisma.staff.findMany({
      where: { active: true, role: { notIn: ["ADMIN", "MANAGER"] } },
      orderBy: { name: "asc" },
    }),
    prisma.staffReview.groupBy({ by: ["staffId"], _avg: { rating: true }, _count: { rating: true } }),
  ]);
  const ratingByStaff = new Map(groupedRatings.map((item) => [item.staffId, item]));
  return NextResponse.json({
    staff: staff.map((item) => {
      const rating = ratingByStaff.get(item.id);
      return {
        ...item,
        ratingAverage: rating?._avg.rating ? Number(rating._avg.rating.toFixed(2)) : null,
        ratingCount: rating?._count.rating || 0,
      };
    }),
  });
}
