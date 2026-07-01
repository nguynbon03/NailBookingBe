import { NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { prisma } from "@/lib/prisma";

const secret = new TextEncoder().encode(process.env.NEXTAUTH_SECRET || "secret");

export async function getAuthUser(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!auth?.toLowerCase().startsWith("bearer ")) return null;

  try {
    const token = auth.replace(/^Bearer\s+/i, "");
    const { payload } = await jwtVerify(token, secret, { clockTolerance: 60 });
    const id = payload.id as string | undefined;
    if (!id) return null;

    return prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, name: true, role: true, phone: true, avatar: true, emailVerifiedAt: true, phoneVerifiedAt: true },
    });
  } catch {
    return null;
  }
}

export function isAdminRole(role?: string | null) {
  return role === "ADMIN" || role === "MANAGER";
}

export function isStaffPortalRole(role?: string | null) {
  return role === "ADMIN" || role === "MANAGER" || role === "STAFF";
}
