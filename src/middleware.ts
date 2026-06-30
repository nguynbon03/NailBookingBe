import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";

const secret = new TextEncoder().encode(process.env.NEXTAUTH_SECRET || "secret");

const allowedOrigins = [
  "https://bookingnail.overpowers.agency",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
];

function isAllowedOrigin(origin: string | null) {
  if (!origin) return true;
  return allowedOrigins.some((o) => origin === o || origin.endsWith(".overpowers.agency"));
}

export async function middleware(req: NextRequest) {
  const origin = req.headers.get("origin");
  const isPreflight = req.method === "OPTIONS";

  // CORS preflight
  if (isPreflight) {
    const headers = new Headers();
    headers.set("Access-Control-Allow-Origin", isAllowedOrigin(origin) ? (origin || "*") : "*");
    headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    headers.set("Access-Control-Allow-Credentials", "true");
    return new NextResponse(null, { status: 204, headers });
  }

  const response = NextResponse.next();
  if (origin && isAllowedOrigin(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Allow-Credentials", "true");
  }

  const adminPaths = ["/admin", "/api/admin"];
  const isAdminPath = adminPaths.some((p) => req.nextUrl.pathname.startsWith(p));

  if (isAdminPath) {
    const token = req.cookies.get("token")?.value;
    if (!token) {
      return NextResponse.redirect(new URL("/login", req.url));
    }
    try {
      const { payload } = await jwtVerify(token, secret);
      const role = payload.role as string;
      if (!["ADMIN", "MANAGER"].includes(role)) {
        return NextResponse.redirect(new URL("/", req.url));
      }
    } catch {
      return NextResponse.redirect(new URL("/login", req.url));
    }
  }

  return response;
}

export const config = { matcher: ["/admin/:path*", "/api/admin/:path*", "/api/:path*"] };
