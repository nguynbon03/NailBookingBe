import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ ok: true, service: "nailbooking-be" });
  } catch (error) {
    return NextResponse.json(
      { ok: false, service: "nailbooking-be", error: "Database unavailable" },
      { status: 500 }
    );
  }
}
