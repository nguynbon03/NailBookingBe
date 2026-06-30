import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function normalizeName(value: unknown) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeKey(value: unknown) {
  return normalizeName(value).toLowerCase();
}

function serializeService(service: any) {
  return {
    ...service,
    price: Number(service.price),
  };
}

async function findDuplicateName(name: string, excludeId?: string) {
  const services = await prisma.service.findMany({ select: { id: true, name: true } });
  return services.find((service) => service.id !== excludeId && normalizeKey(service.name) === normalizeKey(name));
}

function servicePayload(data: any) {
  const name = normalizeName(data.name);
  const category = normalizeName(data.category || "uncategorized");
  const price = Number(data.price);
  const duration = Number(data.duration);

  if (!name) throw new Error("Service name is required");
  if (!Number.isFinite(price) || price < 0) throw new Error("Service price must be a valid number");
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Service duration must be greater than 0");

  return {
    name,
    category,
    price,
    duration: Math.round(duration),
    description: data.description ? String(data.description) : null,
    image: data.image ? String(data.image) : null,
    active: data.active === undefined ? true : Boolean(data.active),
  };
}

export async function GET() {
  const services = await prisma.service.findMany({
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });
  return NextResponse.json({ services: services.map(serializeService) });
}

export async function POST(req: NextRequest) {
  try {
    const data = servicePayload(await req.json());
    const duplicate = await findDuplicateName(data.name);
    if (duplicate) {
      return NextResponse.json({ error: `Service already exists: ${duplicate.name}` }, { status: 409 });
    }
    const service = await prisma.service.create({ data });
    return NextResponse.json({ service: serializeService(service) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to create service" }, { status: 400 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { id, ...body } = await req.json();
    if (!id) return NextResponse.json({ error: "Service id is required" }, { status: 400 });

    const data = servicePayload(body);
    const duplicate = await findDuplicateName(data.name, id);
    if (duplicate) {
      return NextResponse.json({ error: `Service already exists: ${duplicate.name}` }, { status: 409 });
    }

    const service = await prisma.service.update({ where: { id }, data });
    return NextResponse.json({ service: serializeService(service) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to update service" }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: "Service id is required" }, { status: 400 });
    await prisma.service.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: "Failed to delete service" }, { status: 400 });
  }
}
