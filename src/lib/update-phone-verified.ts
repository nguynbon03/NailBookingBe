import { prisma } from "./prisma";
import { normalizeOtpPhone } from "./otp";

/**
 * When OTP verify succeeds, mark user's phone as verified and attach the phone number.
 * This is ONLY required before booking (not for login/register).
 */
export async function markPhoneVerified(userId: string | null | undefined, phoneInput: string) {
  if (!userId) return { updated: false, reason: "no_user" };

  const phone = normalizeOtpPhone(phoneInput);
  if (!phone) return { updated: false, reason: "invalid_phone" };

  try {
    await prisma.user.update({
      where: { id: userId },
      data: {
        phone,
        phoneVerifiedAt: new Date(),
        phoneVerificationSentAt: new Date(),
      },
    });
    return { updated: true, phone };
  } catch (e) {
    return { updated: false, reason: "db_error" };
  }
}
