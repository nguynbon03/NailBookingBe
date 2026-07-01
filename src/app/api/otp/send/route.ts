import { NextRequest, NextResponse } from "next/server";
import { sendOTP, type OtpChannel } from "@/lib/otp";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function cleanChannel(value: unknown): OtpChannel | "auto" {
  const channel = String(value || "auto").toLowerCase();
  return channel === "sms" || channel === "whatsapp" ? channel : "auto";
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const phone = String(body.phone || "").trim();
    if (!phone) {
      return NextResponse.json({ error: "Phone number is required" }, { status: 400 });
    }

    const result = await sendOTP(phone, cleanChannel(body.channel));
    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error || "OTP delivery failed", attempts: result.attempts }, { status: 503 });
    }

    return NextResponse.json({
      success: true,
      message: result.channel === "whatsapp" ? "OTP sent by WhatsApp" : result.channel === "sms" ? "OTP sent by SMS" : "OTP generated in development mode",
      phone: result.phone,
      channel: result.channel,
      attempts: result.attempts?.map((attempt) => ({ channel: attempt.channel, success: attempt.success, skipped: attempt.skipped, error: attempt.error })),
      ...("debugOtp" in result ? { debugOtp: result.debugOtp } : {}),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Internal error";
    const status = message.includes("Too many OTP") ? 429 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
