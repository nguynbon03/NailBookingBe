import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  console.log("[google-webhook] received:", body);
  // TODO: real sync logic with Google Calendar API + booking DB
  return NextResponse.json({ ok: true, received: true, note: "Google 2-way webhook scaffold. Add GOOGLE creds for full sync." });
}

export async function GET() {
  return NextResponse.json({
    status: "scaffold",
    message: "Google Calendar 2-way sync webhook ready. Implement push/pull when credentials provided.",
  });
}
