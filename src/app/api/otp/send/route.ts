import { NextRequest, NextResponse } from "next/server";
import { sendSMSOTP } from "@/lib/otp";
import { getAuthUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { phone } = await req.json();
    if (!phone) {
      return NextResponse.json({ error: "Phone number is required" }, { status: 400 });
    }

    const result = await sendSMSOTP(phone);

    return NextResponse.json({
      success: result.success,
      message: result.success ? "OTP sent successfully" : "Failed to send OTP. Check logs.",
      // Never return real OTP in production
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal error" }, { status: 500 });
  }
}
