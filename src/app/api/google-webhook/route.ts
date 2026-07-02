import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const headers = {
    channelId: req.headers.get("x-goog-channel-id"),
    resourceId: req.headers.get("x-goog-resource-id"),
    resourceState: req.headers.get("x-goog-resource-state"),
    messageNumber: req.headers.get("x-goog-message-number"),
    changed: req.headers.get("x-goog-changed"),
  };
  const body = await req.json().catch(() => ({}));
  await (prisma as any).calendarSyncLog.create({
    data: {
      direction: "GOOGLE_WEBHOOK",
      status: "RECEIVED",
      message: `Google Calendar notification: ${headers.resourceState || "unknown"} ${headers.changed || ""} channel=${headers.channelId || "n/a"} resource=${headers.resourceId || "n/a"}`.slice(0, 500),
    },
  }).catch(() => null);
  return NextResponse.json({ ok: true, received: true, headers, body });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "google-calendar-webhook",
    note: "Webhook endpoint is live. Google push channel setup requires connected calendar credentials and a watch registration job.",
  });
}
