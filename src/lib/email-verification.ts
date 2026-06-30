import { createHash, randomBytes } from "crypto";

const DEFAULT_VERIFY_TTL_MINUTES = 30;

export function normalizeEmail(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

export function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function hashVerificationToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function createVerificationToken(ttlMinutes = DEFAULT_VERIFY_TTL_MINUTES) {
  const token = randomBytes(32).toString("hex");
  return {
    token,
    tokenHash: hashVerificationToken(token),
    expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000),
  };
}

export function publicAppUrl() {
  return (
    process.env.PUBLIC_APP_URL ||
    process.env.FRONTEND_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "https://bookingnail.overpowers.agency"
  ).replace(/\/$/, "");
}

export function bookingVerificationUrl(token: string) {
  return `${publicAppUrl()}/booking/verify?token=${encodeURIComponent(token)}`;
}

export function accountVerificationUrl(token: string) {
  return `${publicAppUrl()}/verify-email?token=${encodeURIComponent(token)}`;
}
