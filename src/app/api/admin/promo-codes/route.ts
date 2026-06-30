import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function serializePromoCode(promo: any) {
  return {
    ...promo,
    remaining: promo.usageLimit == null ? null : Math.max(0, promo.usageLimit - promo.usedCount),
  };
}

function normalizeCode(value: unknown) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "");
}

function payload(data: any) {
  const code = normalizeCode(data.code);
  const discountPercent = Number(data.discountPercent);
  const usageLimit = data.usageLimit === "" || data.usageLimit == null ? null : Number(data.usageLimit);

  if (!code) throw new Error("Promo code is required");
  if (!Number.isInteger(discountPercent) || discountPercent <= 0 || discountPercent > 100) {
    throw new Error("Discount percent must be between 1 and 100");
  }
  if (usageLimit !== null && (!Number.isInteger(usageLimit) || usageLimit <= 0)) {
    throw new Error("Usage limit must be empty or greater than 0");
  }

  return {
    code,
    name: data.name ? String(data.name) : null,
    discountPercent,
    active: data.active === undefined ? true : Boolean(data.active),
    usageLimit,
    startsAt: data.startsAt ? new Date(data.startsAt) : null,
    endsAt: data.endsAt ? new Date(data.endsAt) : null,
  };
}

export async function GET() {
  const promoCodes = await prisma.promoCode.findMany({ orderBy: { createdAt: "desc" } });
  return NextResponse.json({ promoCodes: promoCodes.map(serializePromoCode) });
}

export async function POST(req: NextRequest) {
  try {
    const data = payload(await req.json());
    const promoCode = await prisma.promoCode.create({ data });
    return NextResponse.json({ promoCode: serializePromoCode(promoCode) });
  } catch (error: any) {
    const message = error?.code === "P2002" ? "Promo code already exists" : error instanceof Error ? error.message : "Failed to create promo code";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { id, ...body } = await req.json();
    if (!id) return NextResponse.json({ error: "Promo code id is required" }, { status: 400 });
    const data = payload(body);
    const promoCode = await prisma.promoCode.update({ where: { id }, data });
    return NextResponse.json({ promoCode: serializePromoCode(promoCode) });
  } catch (error: any) {
    const message = error?.code === "P2002" ? "Promo code already exists" : error instanceof Error ? error.message : "Failed to update promo code";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: "Promo code id is required" }, { status: 400 });
    await prisma.promoCode.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete promo code" }, { status: 400 });
  }
}
