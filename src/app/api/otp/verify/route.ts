import { NextRequest, NextResponse } from "next/server";
import { verifyOTP } from "@/lib/otp";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const phone = String(body.phone || "").trim();
    const otp = String(body.otp || body.code || "").trim();
    if (!phone || !otp) {
      return NextResponse.json({ success: false, error: "Phone and OTP are required" }, { status: 400 });
    }

    const isValid = await verifyOTP(phone, otp);
    return NextResponse.json({
      success: isValid,
      message: isValid ? "OTP verified successfully" : "Invalid or expired OTP",
    }, { status: isValid ? 200 : 400 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Internal error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
