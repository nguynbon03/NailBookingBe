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
  const serviceIdsParam = searchParams.get("serviceIds");
  const serviceKeys = Array.from(new Set([
    ...(serviceIdsParam || "").split(","),
    serviceId || "",
  ].map((value) => value.trim()).filter(Boolean)));

  if (!date) return NextResponse.json({ error: "date is required" }, { status: 400 });

  let duration = 30;
  if (serviceKeys.length) {
    const selectedServices = await prisma.service.findMany({
      where: {
        active: true,
        OR: [{ id: { in: serviceKeys } }, { name: { in: serviceKeys } }],
      },
      select: { duration: true },
    });
    duration = selectedServices.reduce((sum: number, service: { duration: number }) => sum + Number(service.duration || 0), 0) || 30;
  }

  const slots = await buildAvailabilitySlots(prisma, date, duration, staffId && staffId !== "any" ? staffId : null);
  return NextResponse.json({ date, duration, serviceCount: serviceKeys.length, slots });
}
