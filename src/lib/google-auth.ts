import bcrypt from "bcryptjs";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { SignJWT } from "jose";
import { OAuth2Client, TokenPayload } from "google-auth-library";
import { prisma } from "@/lib/prisma";
import { normalizeEmail, publicAppUrl } from "@/lib/email-verification";

const secretText = process.env.NEXTAUTH_SECRET || "secret";
const secret = new TextEncoder().encode(secretText);
const STATE_TTL_MS = 10 * 60 * 1000;

function base64url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function signPayload(payload: string) {
  return createHmac("sha256", secretText).update(payload).digest("base64url");
}

function safeCompare(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function googleClientId() {
  return process.env.GOOGLE_CLIENT_ID || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "";
}

export function googleClientSecret() {
  return process.env.GOOGLE_CLIENT_SECRET || "";
}

function normalizedGoogleRedirect(value?: string) {
  const fallback = `${publicAppUrl()}/api/auth/callback/google`;
  const raw = String(value || "").trim() || fallback;
  return raw.replace("/api/google-calendar/callback", "/api/auth/callback/google");
}

export function googleRedirectUri() {
  return normalizedGoogleRedirect(process.env.GOOGLE_REDIRECT_URI);
}

export function googleCalendarRedirectUri() {
  return normalizedGoogleRedirect(process.env.GOOGLE_CALENDAR_REDIRECT_URI || googleRedirectUri());
}

export function sanitizeNext(value: unknown) {
  const next = String(value || "/").trim();
  if (!next.startsWith("/") || next.startsWith("//")) return "/";
  if (next.startsWith("/api/")) return "/";
  return next;
}

type GoogleStateOptions = {
  actorUserId?: string | null;
  actorRole?: string | null;
};

export function createGoogleState(nextInput: unknown, calendar = false, options: GoogleStateOptions = {}) {
  const payload = base64url(JSON.stringify({
    nonce: randomBytes(16).toString("hex"),
    next: sanitizeNext(nextInput),
    calendar,
    actorUserId: options.actorUserId || null,
    actorRole: options.actorRole || null,
    ts: Date.now(),
  }));
  return `${payload}.${signPayload(payload)}`;
}

export function verifyGoogleState(state: unknown) {
  const [payload, signature] = String(state || "").split(".");
  if (!payload || !signature || !safeCompare(signature, signPayload(payload))) throw new Error("invalid_state");
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!parsed.ts || Date.now() - Number(parsed.ts) > STATE_TTL_MS) throw new Error("expired_state");
  return {
    next: sanitizeNext(parsed.next),
    calendar: Boolean(parsed.calendar),
    actorUserId: parsed.actorUserId ? String(parsed.actorUserId) : null,
    actorRole: parsed.actorRole ? String(parsed.actorRole) : null,
  };
}

export function googleAuthorizationUrl(nextInput: unknown, options: { calendar?: boolean; actorUserId?: string | null; actorRole?: string | null } = {}) {
  const clientId = googleClientId();
  if (!clientId) throw new Error("missing_google_client_id");
  const calendar = Boolean(options.calendar);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", calendar ? googleCalendarRedirectUri() : googleRedirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", calendar ? "openid email profile https://www.googleapis.com/auth/calendar.events" : "openid email profile");
  url.searchParams.set("state", createGoogleState(nextInput, calendar, { actorUserId: options.actorUserId, actorRole: options.actorRole }));
  url.searchParams.set("prompt", calendar ? "consent" : "select_account");
  if (calendar) {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("include_granted_scopes", "true");
  }
  return url;
}

export async function exchangeGoogleCode(code: string, options: { calendar?: boolean } = {}) {
  const clientId = googleClientId();
  const clientSecret = googleClientSecret();
  if (!clientId || !clientSecret) throw new Error("google_oauth_not_configured");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: options.calendar ? googleCalendarRedirectUri() : googleRedirectUri(),
      grant_type: "authorization_code",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id_token) throw new Error(data.error_description || data.error || `Google token HTTP ${res.status}`);
  return data as { id_token: string; access_token?: string; refresh_token?: string; scope?: string; expires_in?: number; token_type?: string };
}

export async function verifyGoogleIdToken(idToken: string) {
  const clientId = googleClientId();
  if (!clientId) throw new Error("missing_google_client_id");
  const client = new OAuth2Client(clientId);
  const ticket = await client.verifyIdToken({ idToken, audience: clientId });
  const payload = ticket.getPayload();
  if (!payload) throw new Error("missing_google_payload");
  return payload;
}

export async function createAppSessionFromGooglePayload(payload: TokenPayload) {
  const email = normalizeEmail(payload.email || "");
  if (!email || !payload.email_verified) throw new Error("google_email_not_verified");

  const name = String(payload.name || email.split("@")[0] || "Google User").trim();
  const avatar = payload.picture || null;
  const randomPassword = await bcrypt.hash(`google:${payload.sub}:${secretText}`, 10);

  const user = await prisma.user.upsert({
    where: { email },
    update: { name, avatar, emailVerifiedAt: new Date() },
    create: { email, password: randomPassword, name, avatar, role: "CUSTOMER", emailVerifiedAt: new Date() },
    select: { id: true, email: true, name: true, role: true, phone: true, avatar: true, emailVerifiedAt: true },
  });

  const token = await new SignJWT({ id: user.id, email: user.email, role: user.role })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("7d")
    .sign(secret);

  return { user, token };
}

export function googleCallbackHtml(token: string, next: string) {
  const safeNext = sanitizeNext(next);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Signing in...</title></head><body><p>Signing in with Google...</p><script>localStorage.setItem("token", ${JSON.stringify(token)}); window.location.replace(${JSON.stringify(safeNext)});</script></body></html>`;
}

export function googleCalendarCallbackHtml(next: string, params: Record<string, string>) {
  const url = new URL(sanitizeNext(next), "https://bookingnail.local");
  Object.entries(params).forEach(([key, value]) => {
    if (value) url.searchParams.set(key, value);
  });
  return `<!doctype html><html><head><meta charset="utf-8"><title>Connecting calendar...</title></head><body><p>Returning to admin...</p><script>window.location.replace(${JSON.stringify(`${url.pathname}${url.search}`)});</script></body></html>`;
}
