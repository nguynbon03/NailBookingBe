import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, isAdminRole } from "@/lib/auth";
import { getProtectionSettings } from "@/lib/booking-protection";
import { buildCustomerReport, customerReportCsv, customerReportPdf } from "@/lib/reporting";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const authUser = await getAuthUser(req);
  if (!authUser || !isAdminRole(authUser.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const settings = await getProtectionSettings(prisma as any);
  if (settings.customerExportEnabled === false) {
    return NextResponse.json({ error: "Customer data export is disabled. Turn on export in Admin > Customers before downloading customer files." }, { status: 403 });
  }

  const { searchParams } = req.nextUrl;
  const period = searchParams.get("period") || "month";
  const report = await buildCustomerReport(prisma, period, searchParams.get("date"));
  const format = String(searchParams.get("format") || "pdf").toLowerCase();
  const safeLabel = report.range.label.replace(/[^0-9A-Za-z-]+/g, "_");
  if (format === "csv" || format === "xls" || format === "excel") {
    const csv = customerReportCsv(report);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="nail-lounge-customers-${report.range.period}-${safeLabel}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }
  const pdf = customerReportPdf(report);
  const filename = `nail-lounge-customers-${report.range.period}-${safeLabel}.pdf`;
  return new NextResponse(pdf, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
