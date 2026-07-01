import { NextResponse } from "next/server";
import { googleClientId, googleClientSecret, googleRedirectUri } from "@/lib/google-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const cid = googleClientId();
  const secret = googleClientSecret();
  const redirect = googleRedirectUri();

  return NextResponse.json({
    hasClientId: !!cid,
    clientIdPrefix: cid ? cid.substring(0, 20) + "..." : null,
    hasClientSecret: !!secret,
    secretPrefix: secret ? secret.substring(0, 8) + "..." : null,
    redirectUri: redirect,
    publicAppUrl: process.env.PUBLIC_APP_URL || process.env.NEXT_PUBLIC_APP_URL || "https://bookingnail.overpowers.agency",
    note: "If hasClientId=true and hasClientSecret=true then env is loaded. If not, check Coolify env and redeploy."
  });
}
