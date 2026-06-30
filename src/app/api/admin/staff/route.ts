import { NextRequest, NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const staff = await prisma.staff.findMany({ orderBy: { createdAt: "desc" } });
  return NextResponse.json({ staff });
}

export async function POST(req: NextRequest) {
  try {
    const data = await req.json();
    const staff = await prisma.staff.create({ data });
    return NextResponse.json({ staff });
  } catch (e) {
    return NextResponse.json({ error: "Failed to create staff" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { id, ...data } = await req.json();
    const staff = await prisma.staff.update({ where: { id }, data });
    return NextResponse.json({ staff });
  } catch (e) {
    return NextResponse.json({ error: "Failed to update staff" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { id } = await req.json();
    await prisma.staff.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: "Failed to delete staff" }, { status: 500 });
  }
}
