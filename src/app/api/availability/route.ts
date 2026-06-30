import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildAvailabilitySlots } from "@/lib/availability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const date = searchParams.get("date");
  const staffId = searchParams.get("staffId");
  const serviceId = searchParams.get("serviceId");

  if (!date) return NextResponse.json({ error: "date is required" }, { status: 400 });

  let duration = 30;
  if (serviceId) {
    const service = await prisma.service.findUnique({ where: { id: serviceId }, select: { duration: true } });
    if (service) duration = service.duration;
  }

  const slots = await buildAvailabilitySlots(prisma, date, duration, staffId && staffId !== "any" ? staffId : null);
  return NextResponse.json({ date, duration, slots });
}
