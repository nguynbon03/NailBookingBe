import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const staff = await prisma.staff.findMany({
    where: { active: true, role: { notIn: ["ADMIN", "MANAGER"] } },
    orderBy: { name: "asc" },
  });
  return NextResponse.json({ staff });
}
