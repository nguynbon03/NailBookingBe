import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";

const secret = new TextEncoder().encode(process.env.NEXTAUTH_SECRET || "secret");

export async function middleware(req: NextRequest) {
  const token = req.cookies.get("token")?.value;
  const adminPaths = ["/admin", "/api/admin"];
  const isAdminPath = adminPaths.some(p => req.nextUrl.pathname.startsWith(p));

  if (isAdminPath) {
    if (!token) return NextResponse.redirect(new URL("/login", req.url));
    try {
      const { payload } = await jwtVerify(token, secret);
      const role = payload.role as string;
      if (!["ADMIN", "MANAGER"].includes(role)) return NextResponse.redirect(new URL("/", req.url));
    } catch { return NextResponse.redirect(new URL("/login", req.url)); }
  }
  return NextResponse.next();
}

export const config = { matcher: ["/admin/:path*", "/api/admin/:path*"] };
