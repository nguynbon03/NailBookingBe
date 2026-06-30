import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, isAdminRole } from "@/lib/auth";
import { buildCustomerReport } from "@/lib/reporting";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || !isAdminRole(authUser.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { searchParams } = req.nextUrl;
  const report = await buildCustomerReport(prisma, searchParams.get("period") || "month", searchParams.get("date"));
  return NextResponse.json(report);
}
