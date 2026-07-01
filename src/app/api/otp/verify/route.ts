import { NextRequest, NextResponse } from "next/server";
import { verifyOTP } from "@/lib/otp";
import { markPhoneVerified } from "@/lib/update-phone-verified";
import { getAuthUser } from "@/lib/auth";

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

    if (!isValid) {
      return NextResponse.json({ success: false, message: "Invalid or expired OTP" }, { status: 400 });
    }

    // If user is logged in, mark their phone as verified (for booking anti-spam)
    const authUser = await getAuthUser(req);
    let phoneUpdated = false;

    if (authUser?.id) {
      const result = await markPhoneVerified(authUser.id, phone);
      phoneUpdated = result.updated;
    }

    return NextResponse.json({
      success: true,
      message: "Phone verified successfully",
      phoneVerified: true,
      phoneUpdated,
    }, { status: 200 });

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Internal error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
