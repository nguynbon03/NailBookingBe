import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, isAdminRole } from "@/lib/auth";
import { getProtectionSettings, normalizeBlockType, normalizeBlockValue } from "@/lib/booking-protection";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function numberOrDefault(value: unknown, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function intOrDefault(value: unknown, fallback: number) {
  return Math.max(0, Math.floor(numberOrDefault(value, fallback)));
}

async function requireAdmin(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || !isAdminRole(authUser.role)) return null;
  return authUser;
}

export async function GET(req: NextRequest) {
  const authUser = await requireAdmin(req);
  if (!authUser) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const [settings, blocklist] = await Promise.all([
    getProtectionSettings(prisma as any),
    (prisma as any).customerBlocklist.findMany({ orderBy: { createdAt: "desc" } }),
  ]);

  return NextResponse.json({ settings, blocklist });
}

export async function PUT(req: NextRequest) {
  const authUser = await requireAdmin(req);
  if (!authUser) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const mode = String(body.depositMode || "SMART").toUpperCase();
  const depositMode = ["OFF", "SMART", "REQUIRED"].includes(mode) ? mode : "SMART";

  const settings = await (prisma as any).bookingProtectionSetting.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      depositMode,
      depositAmount: numberOrDefault(body.depositAmount, 10),
      highValueThreshold: numberOrDefault(body.highValueThreshold, 50),
      maxActiveBookingsPerCustomer: intOrDefault(body.maxActiveBookingsPerCustomer, 2),
      maxBookingsPerPhonePerDay: intOrDefault(body.maxBookingsPerPhonePerDay, 3),
      maxBookingsPerEmailPerDay: intOrDefault(body.maxBookingsPerEmailPerDay, 3),
      maxBookingsPerIpPerDay: intOrDefault(body.maxBookingsPerIpPerDay, 8),
      requireDepositForNewCustomer: Boolean(body.requireDepositForNewCustomer),
      requireDepositForWeekend: Boolean(body.requireDepositForWeekend),
      requireDepositForHighValue: Boolean(body.requireDepositForHighValue),
      customerExportEnabled: body.customerExportEnabled === undefined ? true : Boolean(body.customerExportEnabled),
    },
    update: {
      depositMode,
      depositAmount: numberOrDefault(body.depositAmount, 10),
      highValueThreshold: numberOrDefault(body.highValueThreshold, 50),
      maxActiveBookingsPerCustomer: intOrDefault(body.maxActiveBookingsPerCustomer, 2),
      maxBookingsPerPhonePerDay: intOrDefault(body.maxBookingsPerPhonePerDay, 3),
      maxBookingsPerEmailPerDay: intOrDefault(body.maxBookingsPerEmailPerDay, 3),
      maxBookingsPerIpPerDay: intOrDefault(body.maxBookingsPerIpPerDay, 8),
      requireDepositForNewCustomer: Boolean(body.requireDepositForNewCustomer),
      requireDepositForWeekend: Boolean(body.requireDepositForWeekend),
      requireDepositForHighValue: Boolean(body.requireDepositForHighValue),
      ...(body.customerExportEnabled === undefined ? {} : { customerExportEnabled: Boolean(body.customerExportEnabled) }),
    },
  });

  return NextResponse.json({ settings });
}

export async function POST(req: NextRequest) {
  const authUser = await requireAdmin(req);
  if (!authUser) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const type = normalizeBlockType(body.type);
  const value = normalizeBlockValue(type, body.value);
  const reason = String(body.reason || "").trim().slice(0, 300) || null;
  if (!value) return NextResponse.json({ error: "Blacklist value is required" }, { status: 400 });

  const item = await (prisma as any).customerBlocklist.upsert({
    where: { type_value: { type, value } },
    create: { type, value, reason, active: true, createdBy: authUser.email },
    update: { reason, active: true, createdBy: authUser.email },
  });

  return NextResponse.json({ blocklistItem: item });
}

export async function DELETE(req: NextRequest) {
  const authUser = await requireAdmin(req);
  if (!authUser) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const id = String(body.id || "").trim();
  if (!id) return NextResponse.json({ error: "Blacklist id is required" }, { status: 400 });

  const item = await (prisma as any).customerBlocklist.update({ where: { id }, data: { active: false } });
  return NextResponse.json({ blocklistItem: item, removed: true });
}
