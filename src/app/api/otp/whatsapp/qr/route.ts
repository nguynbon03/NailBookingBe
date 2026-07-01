import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isAdminRole } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || !isAdminRole(authUser.role)) {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const base = process.env.EVOLUTION_API_BASE_URL;
  const key = process.env.EVOLUTION_API_KEY;
  const instance = process.env.EVOLUTION_INSTANCE_NAME || "nail-lounge";

  if (!base || !key) {
    return NextResponse.json({
      configured: false,
      message: "Evolution API not configured. Set EVOLUTION_API_BASE_URL and EVOLUTION_API_KEY in Coolify.",
    });
  }

  try {
    // Try to get connection state first
    const stateRes = await fetch(`${base}/instance/connectionState/${encodeURIComponent(instance)}`, {
      headers: { apikey: key },
    });

    if (stateRes.ok) {
      const state = await stateRes.json();
      if (state?.instance?.state === "open" || state?.state === "CONNECTED") {
        return NextResponse.json({ configured: true, connected: true, instance });
      }
    }

    // If not connected, get QR
    const qrRes = await fetch(`${base}/instance/qrcode/${encodeURIComponent(instance)}`, {
      headers: { apikey: key },
    });

    if (!qrRes.ok) {
      const txt = await qrRes.text().catch(() => "");
      return NextResponse.json({ configured: true, connected: false, error: txt || "Failed to get QR" }, { status: 502 });
    }

    const qrData = await qrRes.json();
    return NextResponse.json({
      configured: true,
      connected: false,
      instance,
      qr: qrData?.qrcode || qrData?.base64 || qrData,
    });
  } catch (e: any) {
    return NextResponse.json({ configured: true, error: e.message }, { status: 502 });
  }
}
