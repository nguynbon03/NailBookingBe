import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function normalizeCode(value: unknown) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "");
}

function invalid(message: string, status = 400) {
  return NextResponse.json({ valid: false, error: message }, { status });
}

export async function POST(req: NextRequest) {
  const { code, subtotal } = await req.json().catch(() => ({}));
  const normalized = normalizeCode(code);
  const amount = Number(subtotal || 0);

  if (!normalized) return invalid("Enter a promo code");
  if (!Number.isFinite(amount) || amount <= 0) return invalid("Select a service before applying a promo code");

  const promoCode = await prisma.promoCode.findUnique({ where: { code: normalized } });
  if (!promoCode) return invalid("Promo code not found", 404);
  if (!promoCode.active) return invalid("Promo code is not active");

  const now = new Date();
  if (promoCode.startsAt && promoCode.startsAt > now) return invalid("Promo code is not active yet");
  if (promoCode.endsAt && promoCode.endsAt < now) return invalid("Promo code has expired");
  if (promoCode.usageLimit !== null && promoCode.usedCount >= promoCode.usageLimit) return invalid("Promo code usage limit reached");

  const discount = Math.round(amount * (promoCode.discountPercent / 100) * 100) / 100;
  return NextResponse.json({
    valid: true,
    promoCode: {
      id: promoCode.id,
      code: promoCode.code,
      name: promoCode.name,
      discountPercent: promoCode.discountPercent,
      usedCount: promoCode.usedCount,
      usageLimit: promoCode.usageLimit,
      remaining: promoCode.usageLimit == null ? null : Math.max(0, promoCode.usageLimit - promoCode.usedCount),
    },
    discount,
    finalTotal: Math.max(0, Math.round((amount - discount) * 100) / 100),
  });
}
