import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { reconcileGoogleCalendarWebhook } from "@/lib/google-calendar";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const headers = {
    channelId: req.headers.get("x-goog-channel-id"),
    channelToken: req.headers.get("x-goog-channel-token"),
    resourceId: req.headers.get("x-goog-resource-id"),
    resourceState: req.headers.get("x-goog-resource-state"),
    messageNumber: req.headers.get("x-goog-message-number"),
    changed: req.headers.get("x-goog-changed"),
  };
  const body = await req.json().catch(() => ({}));

  const orFilters: any[] = [];
  if (headers.channelToken) orFilters.push({ id: headers.channelToken });
  if (headers.channelId) orFilters.push({ watchChannelId: headers.channelId });
  if (headers.resourceId) orFilters.push({ watchResourceId: headers.resourceId });

  const connection = orFilters.length
    ? await (prisma as any).googleCalendarConnection.findFirst({
        where: { syncEnabled: true, OR: orFilters },
        orderBy: [{ updatedAt: "desc" }],
      }).catch(() => null)
    : null;

  if (!connection) {
    await (prisma as any).calendarSyncLog.create({
      data: {
        direction: "GOOGLE_WEBHOOK",
        status: "ORPHAN",
        message: `Google Calendar notification without matching connection: state=${headers.resourceState || "unknown"} channel=${headers.channelId || "n/a"} resource=${headers.resourceId || "n/a"}`.slice(0, 500),
      },
    }).catch(() => null);
    return NextResponse.json({ ok: true, orphan: true, headers, body });
  }

  await (prisma as any).googleCalendarConnection.update({
    where: { id: connection.id },
    data: { lastWebhookAt: new Date() },
  }).catch(() => null);

  if (headers.resourceState === "sync") {
    await (prisma as any).calendarSyncLog.create({
      data: {
        direction: "GOOGLE_WEBHOOK",
        status: "SYNC_READY",
        message: `Google Calendar sync handshake received for ${connection.email} channel=${headers.channelId || "n/a"}`.slice(0, 500),
        staffId: connection.staffId || null,
      },
    }).catch(() => null);
    return NextResponse.json({ ok: true, received: true, handshake: true, headers });
  }

  const result = await reconcileGoogleCalendarWebhook(prisma as any, connection);
  return NextResponse.json({ ok: true, received: true, headers, body, result });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "google-calendar-webhook",
    note: "Webhook endpoint is live and now reconciles matching shop Gmail Calendar connections.",
  });
}
