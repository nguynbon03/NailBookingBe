import { NextRequest, NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const services = await prisma.service.findMany({ orderBy: { createdAt: "desc" } });
  return NextResponse.json({ services });
}

export async function POST(req: NextRequest) {
  const data = await req.json();
  const service = await prisma.service.create({ data });
  return NextResponse.json({ service });
}

export async function PUT(req: NextRequest) {
  const { id, ...data } = await req.json();
  const service = await prisma.service.update({ where: { id }, data });
  return NextResponse.json({ service });
}

export async function DELETE(req: NextRequest) {
  const { id } = await req.json();
  await prisma.service.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
