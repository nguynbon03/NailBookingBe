import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, isAdminRole } from "@/lib/auth";
import { getProtectionSettings } from "@/lib/booking-protection";
import { buildCustomerReport } from "@/lib/reporting";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function requireAdmin(req: NextRequest) {
  const authUser = await getAuthUser(req);
  return authUser && isAdminRole(authUser.role) ? authUser : null;
}

export async function GET(req: NextRequest) {
  const authUser = await requireAdmin(req);
  if (!authUser) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { searchParams } = req.nextUrl;
  const [report, settings] = await Promise.all([
    buildCustomerReport(prisma, searchParams.get("period") || "month", searchParams.get("date")),
    getProtectionSettings(prisma as any),
  ]);
  return NextResponse.json({ ...report, exportEnabled: settings.customerExportEnabled !== false });
}

export async function PUT(req: NextRequest) {
  const authUser = await requireAdmin(req);
  if (!authUser) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const exportEnabled = Boolean(body.exportEnabled);
  const settings = await (prisma as any).bookingProtectionSetting.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      customerExportEnabled: exportEnabled,
    },
    update: { customerExportEnabled: exportEnabled },
  });
  return NextResponse.json({ ok: true, exportEnabled: settings.customerExportEnabled !== false });
}
