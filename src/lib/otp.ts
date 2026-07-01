import { createHash, randomBytes } from "crypto";
import { prisma } from "./prisma";
import { normalizePhone, isValidPhone } from "./email-verification";

// Recommended: Use Infobip (SMS + WhatsApp) or Evolution API (WhatsApp self-hosted)
const INFOBIP_BASE_URL = process.env.INFOBIP_BASE_URL || "https://api.infobip.com";
const INFOBIP_API_KEY = process.env.INFOBIP_API_KEY;

export async function generateOTP(length = 6): Promise<string> {
  return randomBytes(3).toString("hex").slice(0, length); // 6 digits by default
}

export function hashOTP(otp: string, salt: string = "nail-lounge-otp"): string {
  return createHash("sha256").update(otp + salt).digest("hex");
}

export async function sendSMSOTP(phone: string): Promise<{ success: boolean; otp: string; messageId?: string }> {
  const normalizedPhone = normalizePhone(phone);
  if (!isValidPhone(normalizedPhone)) {
    throw new Error("Invalid phone number");
  }

  const otp = await generateOTP();
  const hashedOtp = hashOTP(otp);

  // Save to DB with 10 min expiry
  await prisma.oTP.create({
    data: {
      phone: normalizedPhone,
      codeHash: hashedOtp,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      attempts: 0,
    },
  });

  if (!INFOBIP_API_KEY) {
    console.log(`[DEV MODE] OTP for ${normalizedPhone}: ${otp}`);
    return { success: true, otp }; // In dev, return OTP in log
  }

  try {
    const response = await fetch(`${INFOBIP_BASE_URL}/sms/1/text/advanced`, {
      method: "POST",
      headers: {
        "Authorization": `App ${INFOBIP_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [{
          destinations: [{ to: normalizedPhone }],
          text: `Your Nail Lounge verification code is: ${otp}. Valid for 10 minutes. Do not share it.`,
        }],
      }),
    });

    const data = await response.json();
    return { success: response.ok, otp, messageId: data.messages?.[0]?.messageId };
  } catch (error) {
    console.error("SMS send failed:", error);
    return { success: false, otp }; // Still return OTP for fallback
  }
}

export async function verifyOTP(phone: string, inputOtp: string): Promise<boolean> {
  const normalizedPhone = normalizePhone(phone);
  const record = await prisma.oTP.findFirst({
    where: { phone: normalizedPhone, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });

  if (!record || record.attempts >= 5) return false;

  const isValid = record.codeHash === hashOTP(inputOtp);

  if (!isValid) {
    await prisma.oTP.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
    });
    return false;
  }

  // Mark as used
  await prisma.oTP.update({
    where: { id: record.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });

  return true;
}

// Add to schema later if not exists
// model OTP {
//   id        String   @id @default(cuid())
//   phone     String
//   codeHash  String
//   expiresAt DateTime
//   attempts  Int      @default(0)
//   createdAt DateTime @default(now())
//   @@index([phone, expiresAt])
// }
