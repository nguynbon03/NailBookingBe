import { NextRequest, NextResponse } from "next/server";
import { verifyOTP } from "@/lib/otp";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { phone, otp } = await req.json();
    if (!phone || !otp) {
      return NextResponse.json({ error: "Phone and OTP are required" }, { status: 400 });
    }

    const isValid = await verifyOTP(phone, otp);

    return NextResponse.json({
      success: isValid,
      message: isValid ? "OTP verified successfully" : "Invalid or expired OTP",
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal error" }, { status: 500 });
  }
}
