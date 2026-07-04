import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";

const secret = new TextEncoder().encode(process.env.NEXTAUTH_SECRET || "secret");

const allowedOrigins = [
  "https://bookingnail.overpowers.agency",
  "https://api.overpowers.agency",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
];

function isAllowedOrigin(origin: string | null) {
  if (!origin) return true;
  return allowedOrigins.some((o) => origin === o || origin.endsWith(".overpowers.agency"));
}

function corsHeaders(origin: string | null) {
  const headers = new Headers();
  if (isAllowedOrigin(origin)) {
    headers.set("Access-Control-Allow-Origin", origin || "*");
    headers.set("Access-Control-Allow-Credentials", "true");
  }
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Vary", "Origin");
  return headers;
}

async function verifyAdminToken(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") || req.cookies.get("token")?.value;
  if (!token) return { ok: false, status: 401 };
  try {
    const { payload } = await jwtVerify(token, secret, { clockTolerance: 60 });
    const role = payload.role as string;
    if (!["ADMIN", "MANAGER"].includes(role)) return { ok: false, status: 403 };
    return { ok: true, status: 200 };
  } catch {
    return { ok: false, status: 401 };
  }
}

export async function proxy(req: NextRequest) {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
  }

  const response = NextResponse.next();
  const headers = corsHeaders(origin);
  headers.forEach((value, key) => response.headers.set(key, value));

  if (req.nextUrl.pathname.startsWith("/api/admin")) {
    const verified = await verifyAdminToken(req);
    if (!verified.ok) {
      return NextResponse.json(
        { error: verified.status === 403 ? "Forbidden" : "Unauthorized" },
        { status: verified.status, headers }
      );
    }
  }

  return response;
}

export const config = { matcher: ["/api/:path*"] };
