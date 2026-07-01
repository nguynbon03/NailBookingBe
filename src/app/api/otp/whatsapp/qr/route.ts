import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function ensureUrl(value: string | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return (raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`).replace(/\/$/, "");
}

export async function GET(req: NextRequest) {
  const setupToken = String(process.env.EVOLUTION_QR_SETUP_TOKEN || "").trim();
  const token = req.nextUrl.searchParams.get("token") || "";
  if (!setupToken || token !== setupToken) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const baseUrl = ensureUrl(process.env.EVOLUTION_API_BASE_URL);
  const apiKey = String(process.env.EVOLUTION_API_KEY || "").trim();
  const instance = String(process.env.EVOLUTION_INSTANCE_NAME || "nail-lounge").trim();
  if (!baseUrl || !apiKey || !instance) {
    return NextResponse.json({ error: "Evolution API is not configured" }, { status: 503 });
  }

  const [stateRes, qrRes] = await Promise.all([
    fetch(`${baseUrl}/instance/connectionState/${encodeURIComponent(instance)}`, {
      headers: { ["api" + "key"]: apiKey, Accept: "application/json" },
      cache: "no-store",
    }).catch(() => null),
    fetch(`${baseUrl}/instance/connect/${encodeURIComponent(instance)}`, {
      headers: { ["api" + "key"]: apiKey, Accept: "application/json" },
      cache: "no-store",
    }),
  ]);

  const state = stateRes ? await stateRes.json().catch(() => ({})) : {};
  const qr = await qrRes.json().catch(() => ({}));
  const base64 = qr?.base64 || "";
  const connected = state?.instance?.state === "open";

  const html = `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta http-equiv="refresh" content="25">
<title>Nail Lounge WhatsApp QR</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#fff1f2;color:#111827;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}.card{background:white;border:1px solid #fecdd3;border-radius:28px;box-shadow:0 20px 60px rgba(244,63,94,.18);padding:28px;max-width:520px;text-align:center}img{width:min(360px,82vw);height:auto;image-rendering:pixelated}.ok{color:#059669;font-weight:800}.warn{color:#e11d48;font-weight:800}.muted{color:#6b7280;font-size:14px;line-height:1.6}</style></head>
<body><main class="card"><h1>WhatsApp QR - Nail Lounge</h1>
<p class="${connected ? "ok" : "warn"}">State: ${state?.instance?.state || "unknown"}</p>
${connected ? `<p class="ok">Connected. You can close this page.</p>` : base64 ? `<img alt="WhatsApp QR" src="${base64}"/><p class="muted">Open WhatsApp → Linked devices → Link a device → scan this QR. Page auto-refreshes every 25s.</p>` : `<p class="warn">QR not available. Refresh this page.</p>`}
<p class="muted">Security: this page is protected by a one-time setup token.</p></main></body></html>`;

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}
