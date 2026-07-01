import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const event = String(body.event || "unknown");
    const instance = String(body.instance || body.data?.instance || "nail-lounge");
    const state = String(body.data?.state || body.state || "");

    console.log("[Evolution Webhook]", JSON.stringify({ event, instance, state }));
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Webhook error";
    console.error("[Evolution Webhook]", message);
    return NextResponse.json({ success: false }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, service: "evolution-webhook" });
}
