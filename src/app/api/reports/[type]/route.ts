import { withAuth, fail, ok } from "@/lib/api/helpers";
import { runReport, reportTitle } from "@/lib/services/reports";
import { resolveRange, RangePreset, toCSV } from "@/lib/utils";
import type { ReportType } from "@/lib/types";

type Ctx = { params: Promise<{ type: string }> };

const VALID: ReportType[] = [
  "sales", "orders", "delivered", "returned", "worker-performance", "worker-commission",
  "worker-payments", "pending-payments", "inventory", "stock-movement", "product-sales", "customer",
];

export const GET = withAuth(["super_admin", "admin"], async (_session, req, ctx) => {
  const { type } = await (ctx as Ctx).params;
  if (!VALID.includes(type as ReportType)) return fail("Unknown report.", 404);
  const url = new URL(req.url);
  const preset = (url.searchParams.get("preset") || "this_month") as RangePreset;
  const range = resolveRange(preset, url.searchParams.get("from") ?? undefined, url.searchParams.get("to") ?? undefined);
  const report = await runReport(type as ReportType, { from: range.from, to: range.to });
  const format = url.searchParams.get("format");

  if (format === "csv") {
    const csv = toCSV(report.columns, report.rows);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${type}-${range.from}-to-${range.to}.csv"`,
      },
    });
  }

  return ok({
    title: reportTitle(type as ReportType),
    range: { from: range.from, to: range.to, preset },
    ...report,
  });
});
