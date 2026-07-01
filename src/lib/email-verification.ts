import { createHash, randomBytes } from "crypto";

const DEFAULT_VERIFY_TTL_MINUTES = 30;

export function normalizeEmail(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

export function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function normalizeVerificationToken(value: unknown) {
  const match = String(value || "").trim().match(/[a-f0-9]{64}/i);
  return match ? match[0].toLowerCase() : "";
}

export function hashVerificationToken(token: string) {
  return createHash("sha256").update(normalizeVerificationToken(token) || token).digest("hex");
}

export function normalizePhone(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.replace(/[\s().-]+/g, "").replace(/^00/, "+");
}

export function isValidPhone(phone: string) {
  return /^\+?[0-9]{7,15}$/.test(normalizePhone(phone));
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
