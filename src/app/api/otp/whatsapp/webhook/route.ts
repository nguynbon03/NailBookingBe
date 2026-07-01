import { NextRequest, NextResponse } from "next/server";

// Webhook to receive events from Evolution API (connection status, message status, etc.)
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    console.log("[Evolution Webhook]", JSON.stringify(body, null, 2));

    // Example: handle connection update
    if (body.event === "connection.update") {
      if (body.data?.state === "open") {
        console.log("✅ WhatsApp connected successfully!");
      }
    }

    // You can add more logic here (e.g. mark OTP as delivered)

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("Webhook error:", error);
    return NextResponse.json({ success: false }, { status: 500 });
  }
}

// Also support GET for health check
export async function GET() {
  return NextResponse.json({ ok: true, service: "evolution-webhook" });
}
