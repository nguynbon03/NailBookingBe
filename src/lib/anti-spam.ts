import { NextRequest } from "next/server";
import { prisma } from "./prisma";
import { createHash } from "crypto";

// Recommended: Cloudflare Turnstile (free, privacy-friendly, excellent bot protection)
export const CAPTCHA_PROVIDER = "turnstile"; // or "hcaptcha"

export interface CaptchaVerification {
  success: boolean;
  error?: string;
}

export async function verifyCaptcha(token: string | null, ip: string | null): Promise<CaptchaVerification> {
  if (!token) {
    return { success: false, error: "CAPTCHA token is required" };
  }

  const secret = process.env.TURNSTILE_SECRET_KEY || process.env.HCAPTCHA_SECRET_KEY;
  if (!secret) {
    console.warn("CAPTCHA secret not configured - skipping verification in dev");
    return { success: true };
  }

  try {
    const formData = new URLSearchParams();
    formData.append("secret", secret);
    formData.append("response", token);
    if (ip) formData.append("remoteip", ip);

    const endpoint = CAPTCHA_PROVIDER === "turnstile" 
      ? "https://challenges.cloudflare.com/turnstile/v0/siteverify"
      : "https://hcaptcha.com/siteverify";

    const res = await fetch(endpoint, {
      method: "POST",
      body: formData,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    const data = await res.json();
    return { 
      success: Boolean(data.success),
      error: data["error-codes"] ? data["error-codes"].join(", ") : undefined 
    };
  } catch (err) {
    console.error("CAPTCHA verification failed:", err);
    return { success: false, error: "CAPTCHA service unavailable" };
  }
}

export function getClientFingerprint(req: NextRequest): string {
  const ip = getClientIp(req);
  const ua = req.headers.get("user-agent") || "";
  const accept = req.headers.get("accept") || "";
  const hashInput = `${ip}|${ua}|${accept}`.slice(0, 500);
  return createHash("sha256").update(hashInput).digest("hex").slice(0, 32);
}

export function getClientIp(req: NextRequest): string | null {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null
  );
}

export async function isRateLimited(
  identifier: string, 
  type: "ip" | "email" | "phone" | "fingerprint",
  windowSeconds: number = 60,
  maxRequests: number = 5
): Promise<boolean> {
  if (!identifier) return false;

  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - windowSeconds;
  const key = `ratelimit:${type}:${identifier}`;

  try {
    // Simple in-memory + DB fallback for production (Redis recommended for scale)
    const recent = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) as count FROM (
        SELECT 1 FROM "Booking" 
        WHERE "sourceIp" = $1 
        AND "createdAt" > NOW() - INTERVAL '1 minute'
        UNION ALL
        SELECT 1 FROM "Booking" 
        WHERE "customerEmail" = $2 
        AND "createdAt" > NOW() - INTERVAL '1 minute'
      ) as sub`,
      type === "ip" ? identifier : null,
      type === "email" ? identifier : null
    );

    const count = Number((recent as any[])[0]?.count || 0);
    return count >= maxRequests;
  } catch {
    return false; // Fail open in case of DB issues
  }
}

export function isHoneypotTriggered(body: any): boolean {
  // Honeypot fields that bots often fill
  const honeypots = ["honeypot", "website", "url", "comment", "subject", "name2"];
  for (const field of honeypots) {
    if (body[field] && String(body[field]).trim() !== "") {
      return true;
    }
  }
  return false;
}

// Server-side validation following Zenoti/Picktime best practices
export function validateBookingInput(body: any) {
  const errors: string[] = [];

  if (!body.customerName || String(body.customerName).trim().length < 2) {
    errors.push("Valid customer name is required");
  }

  const phone = String(body.customerPhone || "").trim();
  if (!phone || !/^\+?[0-9\s\-\(\)]{7,15}$/.test(phone)) {
    errors.push("Valid phone number is required");
  }

  const email = String(body.customerEmail || "").trim().toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push("Valid email address is required");
  }

  if (!body.date || !body.time) {
    errors.push("Date and time are required");
  }

  if (!body.serviceIds || !Array.isArray(body.serviceIds) || body.serviceIds.length === 0) {
    errors.push("At least one service must be selected");
  }

  return { isValid: errors.length === 0, errors };
}
