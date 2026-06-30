import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_STAFF_PASSWORD = "staff123";

function staffPayload(data: any) {
  return {
    name: String(data.name || "").trim(),
    email: String(data.email || "").trim().toLowerCase(),
    phone: data.phone ? String(data.phone) : null,
    role: String(data.role || "THERAPIST"),
    bio: data.bio ? String(data.bio) : null,
    avatar: data.avatar ? String(data.avatar) : null,
    active: data.active === undefined ? true : Boolean(data.active),
  };
}

async function upsertStaffLogin(data: { name: string; email: string; phone: string | null }, password?: string) {
  if (!data.email) return;
  const existing = await prisma.user.findUnique({ where: { email: data.email } });
  const updateData = { name: data.name, phone: data.phone, role: "STAFF" as const, emailVerifiedAt: new Date() };
  if (existing) {
    await prisma.user.update({ where: { email: data.email }, data: updateData });
    if (password) {
      await prisma.user.update({ where: { email: data.email }, data: { password: await bcrypt.hash(password, 10) } });
    }
    return;
  }

  await prisma.user.create({
    data: {
      email: data.email,
      name: data.name,
      phone: data.phone,
      role: "STAFF",
      password: await bcrypt.hash(password || DEFAULT_STAFF_PASSWORD, 10),
      emailVerifiedAt: new Date(),
    },
  });
}

export async function GET() {
  const staff = await prisma.staff.findMany({ orderBy: { name: "asc" } });
  return NextResponse.json({ staff });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const data = staffPayload(body);
    if (!data.name || !data.email) return NextResponse.json({ error: "Staff name and email are required" }, { status: 400 });

    const staff = await prisma.staff.create({ data });
    await upsertStaffLogin(data, body.loginPassword ? String(body.loginPassword) : undefined);
    return NextResponse.json({ staff });
  } catch (e: any) {
    const message = e?.code === "P2002" ? "Staff email already exists" : "Failed to create staff";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const { id } = body;
    if (!id) return NextResponse.json({ error: "Staff id is required" }, { status: 400 });

    const data = staffPayload(body);
    if (!data.name || !data.email) return NextResponse.json({ error: "Staff name and email are required" }, { status: 400 });

    const staff = await prisma.staff.update({ where: { id }, data });
    await upsertStaffLogin(data, body.loginPassword ? String(body.loginPassword) : undefined);
    return NextResponse.json({ staff });
  } catch (e: any) {
    const message = e?.code === "P2002" ? "Staff email already exists" : "Failed to update staff";
    return NextResponse.json({ error: message }, { status: 500 });
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
