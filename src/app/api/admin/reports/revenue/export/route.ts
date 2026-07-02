import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, isAdminRole } from "@/lib/auth";
import { buildRevenueReport, revenueReportCsv, revenueReportPdf } from "@/lib/reporting";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || !isAdminRole(authUser.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { searchParams } = req.nextUrl;
  const report = await buildRevenueReport(
    prisma,
    searchParams.get("period") || "month",
    searchParams.get("date"),
    searchParams.get("fromDate"),
    searchParams.get("toDate"),
  );
  const format = String(searchParams.get("format") || "pdf").toLowerCase();
  const safeLabel = report.range.label.replace(/[^0-9A-Za-z-]+/g, "_");
  if (format === "csv" || format === "xls" || format === "excel") {
    const csv = revenueReportCsv(report);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="nail-lounge-revenue-${report.range.period}-${safeLabel}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }
  const pdf = revenueReportPdf(report);
  const filename = `nail-lounge-revenue-${report.range.period}-${safeLabel}.pdf`;
  return new NextResponse(pdf, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
