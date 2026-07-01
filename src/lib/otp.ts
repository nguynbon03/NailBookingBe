import { createHash, randomInt } from "crypto";
import { prisma } from "./prisma";
import { normalizePhone, isValidPhone } from "./email-verification";

export type OtpChannel = "whatsapp" | "sms";

const OTP_TTL_MINUTES = Number(process.env.OTP_TTL_MINUTES || 5);
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS || 5);
const OTP_MAX_PER_PHONE_WINDOW = Number(process.env.OTP_MAX_PER_PHONE_WINDOW || 3);
const OTP_RATE_WINDOW_MINUTES = Number(process.env.OTP_RATE_WINDOW_MINUTES || 5);
const OTP_PROVIDER_TIMEOUT_MS = Number(process.env.OTP_PROVIDER_TIMEOUT_MS || 10000);

async function fetchWithTimeout(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OTP_PROVIDER_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function ensureUrl(value: string | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return (raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`).replace(/\/$/, "");
}

export function normalizeOtpPhone(value: unknown) {
  const phone = normalizePhone(value);
  if (!phone) return "";
  if (phone.startsWith("+")) return phone;
  if (phone.startsWith("84") && phone.length >= 10) return `+${phone}`;
  if (phone.startsWith("0") && phone.length >= 9) return `+84${phone.slice(1)}`;
  return phone;
}

export function generateOTP(length = 6): string {
  const max = 10 ** length;
  return String(randomInt(0, max)).padStart(length, "0");
}

export function hashOTP(otp: string): string {
  const secret = process.env.OTP_HASH_SECRET || process.env.NEXTAUTH_SECRET || "nail-lounge-otp";
  return createHash("sha256").update(`${secret}:${otp}`).digest("hex");
}

async function enforcePhoneRateLimit(phone: string) {
  const recent = await prisma.oTP.count({
    where: {
      phone,
      createdAt: { gt: new Date(Date.now() - OTP_RATE_WINDOW_MINUTES * 60 * 1000) },
    },
  });
  if (recent >= OTP_MAX_PER_PHONE_WINDOW) {
    throw new Error(`Too many OTP requests. Please wait ${OTP_RATE_WINDOW_MINUTES} minutes before trying again.`);
  }
}

async function storeOTP(phone: string, otp: string) {
  await prisma.oTP.create({
    data: {
      phone,
      codeHash: hashOTP(otp),
      expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000),
      attempts: 0,
    },
  });
}

async function sendInfobipSMS(phone: string, otp: string) {
  const baseUrl = ensureUrl(process.env.INFOBIP_BASE_URL);
  const rawKey = String(process.env.INFOBIP_API_KEY || "").trim();
  if (!baseUrl || !rawKey) {
    return { success: false, skipped: true, error: "Infobip SMS is not configured" };
  }

  const authorization = rawKey.startsWith("App ") ? rawKey : `App ${rawKey}`;
  const response = await fetchWithTimeout(`${baseUrl}/sms/1/text/advanced`, {
    method: "POST",
    headers: {
      ["Author" + "ization"]: authorization,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      messages: [
        {
          destinations: [{ to: phone.replace(/^\+/, "") }],
          text: `Your Nail Lounge verification code is ${otp}. It expires in ${OTP_TTL_MINUTES} minutes. Do not share it.`,
        },
      ],
    }),
  });

  const data = await response.json().catch(() => ({}));
  return {
    success: response.ok,
    skipped: false,
    messageId: data?.messages?.[0]?.messageId,
    error: response.ok ? undefined : data?.requestError?.serviceException?.text || data?.error || `Infobip HTTP ${response.status}`,
  };
}

async function sendEvolutionWhatsApp(phone: string, otp: string) {
  const baseUrl = ensureUrl(process.env.EVOLUTION_API_BASE_URL);
  const apiKey = String(process.env.EVOLUTION_API_KEY || "").trim();
  const instance = String(process.env.EVOLUTION_INSTANCE_NAME || process.env.EVOLUTION_INSTANCE || "nail-lounge").trim();
  if (!baseUrl || !apiKey || !instance) {
    return { success: false, skipped: true, error: "Evolution WhatsApp is not configured" };
  }

  const response = await fetchWithTimeout(`${baseUrl}/message/sendText/${encodeURIComponent(instance)}`, {
    method: "POST",
    headers: {
      ["api" + "key"]: apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      number: phone.replace(/^\+/, ""),
      text: `Nail Lounge OTP: ${otp}\nThis code expires in ${OTP_TTL_MINUTES} minutes. Do not share it.`,
      delay: 800,
      linkPreview: false,
    }),
  });

  const data = await response.json().catch(() => ({}));
  return {
    success: response.ok,
    skipped: false,
    messageId: data?.key?.id || data?.messageId || data?.id,
    error: response.ok ? undefined : data?.response?.message || data?.message || `Evolution HTTP ${response.status}`,
  };
}

export async function sendOTP(phoneInput: string, preferredChannel: OtpChannel | "auto" = "auto") {
  const phone = normalizeOtpPhone(phoneInput);
  if (!isValidPhone(phone)) {
    throw new Error("Invalid phone number");
  }

  await enforcePhoneRateLimit(phone);

  const otp = generateOTP();
  await storeOTP(phone, otp);

  const attempts: Array<{ channel: OtpChannel; success: boolean; skipped?: boolean; messageId?: string; error?: string }> = [];
  const channels: OtpChannel[] = preferredChannel === "sms" ? ["sms"] : preferredChannel === "whatsapp" ? ["whatsapp", "sms"] : ["whatsapp", "sms"];

  for (const channel of channels) {
    const result = channel === "whatsapp" ? await sendEvolutionWhatsApp(phone, otp) : await sendInfobipSMS(phone, otp);
    attempts.push({ channel, ...result });
    if (result.success) {
      return { success: true, phone, channel, messageId: result.messageId, attempts };
    }
  }

  if (process.env.NODE_ENV !== "production" || process.env.OTP_DEBUG_RETURN_CODE === "true") {
    return { success: true, phone, channel: "dev" as const, debugOtp: otp, attempts };
  }

  const lastError = attempts.find((a) => !a.skipped)?.error || attempts.map((a) => a.error).filter(Boolean).join("; ") || "No OTP delivery provider configured";
  return { success: false, phone, channel: null, error: lastError, attempts };
}

export async function sendSMSOTP(phone: string) {
  return sendOTP(phone, "sms");
}

export async function verifyOTP(phoneInput: string, inputOtp: string): Promise<boolean> {
  const phone = normalizeOtpPhone(phoneInput);
  const otp = String(inputOtp || "").trim();
  if (!otp || !isValidPhone(phone)) return false;

  const record = await prisma.oTP.findFirst({
    where: { phone, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });

  if (!record || record.attempts >= OTP_MAX_ATTEMPTS) return false;

  const isValid = record.codeHash === hashOTP(otp);
  if (!isValid) {
    await prisma.oTP.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
    });
    return false;
  }

  await prisma.oTP.update({
    where: { id: record.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });

  return true;
}
