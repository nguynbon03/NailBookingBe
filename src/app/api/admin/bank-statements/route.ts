import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, isAdminRole } from "@/lib/auth";
import { importBankStatementCsv, listBankStatementEntries } from "@/lib/bank-statements";
import { resolvePeriod } from "@/lib/reporting";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function requireAdmin(req: NextRequest) {
  const authUser = await getAuthUser(req);
  return authUser && isAdminRole(authUser.role) ? authUser : null;
}

export async function GET(req: NextRequest) {
  const authUser = await requireAdmin(req);
  if (!authUser) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { searchParams } = req.nextUrl;
  const range = resolvePeriod(
    searchParams.get("period") || "month",
    searchParams.get("date"),
    searchParams.get("fromDate"),
    searchParams.get("toDate"),
  );
  const entries = await listBankStatementEntries(prisma, range.start, range.end);
  const credits = entries.filter((entry: any) => Number(entry.amount || 0) > 0);
  const debits = entries.filter((entry: any) => Number(entry.amount || 0) < 0);
  return NextResponse.json({
    range,
    openBanking: {
      configured: Boolean(process.env.OPEN_BANKING_PROVIDER && process.env.OPEN_BANKING_CLIENT_ID && process.env.OPEN_BANKING_CLIENT_SECRET),
      provider: process.env.OPEN_BANKING_PROVIDER || "manual_statement_import",
      note: "Manual bank statement import is active now. True Open Banking auto-sync needs provider credentials and owner bank consent.",
    },
    entries: entries.map((entry: any) => ({
      ...entry,
      amount: Number(entry.amount || 0),
      matchedConfidence: entry.matchedConfidence == null ? null : Number(entry.matchedConfidence),
    })),
    summary: {
      total: entries.length,
      creditTotal: Math.round(credits.reduce((sum: number, entry: any) => sum + Number(entry.amount || 0), 0) * 100) / 100,
      debitTotal: Math.round(debits.reduce((sum: number, entry: any) => sum + Math.abs(Number(entry.amount || 0)), 0) * 100) / 100,
      matched: credits.filter((entry: any) => entry.matchedBookingId).length,
      unmatched: credits.filter((entry: any) => !entry.matchedBookingId).length,
    },
  });
}

export async function POST(req: NextRequest) {
  const authUser = await requireAdmin(req);
  if (!authUser) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const csv = String(body.csv || body.statement || "");
  if (!csv.trim()) return NextResponse.json({ error: "CSV bank statement content is required" }, { status: 400 });
  const result = await importBankStatementCsv(prisma, csv, String(body.source || "manual_statement"));
  await prisma.notification.create({
    data: {
      audience: "ADMIN",
      type: "BANK_STATEMENT_IMPORTED",
      title: "Bank statement imported",
      message: `${authUser.name || "Admin"} imported ${result.imported} bank transaction(s). Matched ${result.matched}; skipped ${result.skipped}.`,
    },
  });
  return NextResponse.json(result);
}
