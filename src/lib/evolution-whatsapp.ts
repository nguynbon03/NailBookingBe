/**
 * Evolution API - WhatsApp Integration for OTP
 * Self-hosted, free, unlimited messages
 */

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || "http://100.118.114.57:8080";
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || "evolution-otp-key-2026";
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || "nail-lounge";

export interface SendWhatsAppResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export async function sendWhatsAppOTP(
  phone: string, 
  otp: string
): Promise<SendWhatsAppResult> {
  const normalizedPhone = phone.replace(/^\+/, "").replace(/^84/, "84"); // 84339351204 format

  const message = `Your Nail Lounge verification code is: ${otp}\n\nThis code expires in 5 minutes. Do not share it with anyone.`;

  try {
    const response = await fetch(`${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": EVOLUTION_API_KEY,
      },
      body: JSON.stringify({
        number: normalizedPhone,
        text: message,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `Evolution API error: ${response.status} - ${errorText}` };
    }

    const data = await response.json();
    return { 
      success: true, 
      messageId: data.key?.id || data.messageId 
    };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// For future template messages (after you register templates)
export async function sendWhatsAppTemplateOTP(phone: string, otp: string) {
  // Implementation for approved templates later
  return sendWhatsAppOTP(phone, otp);
}
