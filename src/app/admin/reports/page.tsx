"use client";

import { Suspense, useMemo, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useApi, buildQuery } from "@/lib/client";
import { PageHeader, PageSpinner, ErrorState } from "@/components/app/states";
import { RangeFilter } from "@/components/app/filters";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate, formatNumber, toCSV } from "@/lib/utils";
import type { ReportTable, ReportType } from "@/lib/types";
import { Download, Printer } from "lucide-react";

const REPORTS: { key: ReportType; label: string }[] = [
  { key: "sales", label: "Sales" },
  { key: "orders", label: "Orders" },
  { key: "delivered", label: "Delivered" },
  { key: "returned", label: "Returned" },
  { key: "worker-performance", label: "Worker Performance" },
  { key: "worker-commission", label: "Worker Commission" },
  { key: "worker-payments", label: "Worker Payments" },
  { key: "pending-payments", label: "Pending Payments" },
  { key: "inventory", label: "Inventory" },
  { key: "stock-movement", label: "Stock Movement" },
  { key: "product-sales", label: "Product Sales" },
  { key: "customer", label: "Customer" },
];

interface ReportResponse extends ReportTable {
  title: string;
  range: { from: string; to: string; preset: string };
}

function ReportsContent() {
  const params = useSearchParams();
  const router = useRouter();
  const report = (params.get("report") as ReportType) ?? "sales";
  const [range, setRange] = useState<{ preset: string; from?: string; to?: string }>({ preset: "this_month" });

  const query = buildQuery({
    preset: range.preset,
    from: range.preset === "custom" ? range.from : undefined,
    to: range.preset === "custom" ? range.to : undefined,
  });
  const { data, loading, error, refresh } = useApi<ReportResponse>(`/api/reports/${report}${query}`, [report, range.preset, range.from, range.to]);

  const csvUrl = `/api/reports/${report}?format=csv${query ? "&" + query.slice(1) : ""}`;

  const downloadCSV = () => {
    if (!data) return;
    const csv = toCSV(data.columns, data.rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${report}-${data.range.from}-to-${data.range.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const renderCell = useMemo(
    () => (col: ReportTable["columns"][number], value: string | number | null) => {
      if (value === null || value === undefined) return "—";
      if (col.type === "currency") return formatCurrency(Number(value));
      if (col.type === "number") return formatNumber(Number(value));
      if (col.type === "date") return formatDate(String(value));
      return String(value);
    },
    []
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Reports"
        description={data ? `${data.title} · ${data.range.from} → ${data.range.to}` : "Business intelligence across orders, workers and stock"}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={downloadCSV} disabled={!data?.rows.length}>
              <Download className="mr-1.5 h-4 w-4" /> CSV
            </Button>
            <Button variant="outline" onClick={() => window.print()} disabled={!data?.rows.length}>
              <Printer className="mr-1.5 h-4 w-4" /> Print
            </Button>
          </div>
        }
      />

      {/* Report tabs */}
      <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-thin no-print" role="tablist" aria-label="Report types">
        {REPORTS.map((r) => (
          <Button
            key={r.key}
            role="tab"
            aria-selected={report === r.key}
            size="sm"
            variant={report === r.key ? "default" : "outline"}
            className="h-8 shrink-0 rounded-full px-3.5 text-xs"
            onClick={() => router.replace(`/admin/reports?report=${r.key}`)}
          >
            {r.label}
          </Button>
        ))}
      </div>

      <RangeFilter value={range} onChange={setRange} />

      <div className="print-area overflow-hidden rounded-xl border border-border bg-card">
        {loading && !data ? (
          <PageSpinner />
        ) : error ? (
          <div className="p-4">
            <ErrorState message={error} onRetry={refresh} />
          </div>
        ) : data ? (
          data.rows.length === 0 ? (
            <p className="px-4 py-14 text-center text-sm text-muted-foreground">No data for this report and date range.</p>
          ) : (
            <>
              <div className="overflow-x-auto scrollbar-thin">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-muted/60">
                      {data.columns.map((c) => (
                        <th key={c.key} className="whitespace-nowrap px-4 py-2.5 text-left font-semibold">
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row, i) => (
                      <tr key={i} className="border-t border-border/60 hover:bg-muted/30">
                        {data.columns.map((c) => (
                          <td key={c.key} className="whitespace-nowrap px-4 py-2.5">
                            {renderCell(c, row[c.key])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                  {data.totals ? (
                    <tfoot>
                      <tr className="border-t-2 border-border bg-muted/40 font-semibold">
                        {data.columns.map((c) => (
                          <td key={c.key} className="whitespace-nowrap px-4 py-2.5">
                            {c.key in (data.totals ?? {}) ? renderCell(c, (data.totals as Record<string, number>)[c.key]) : c.key === data.columns[0].key ? "Total" : ""}
                          </td>
                        ))}
                      </tr>
                    </tfoot>
                  ) : null}
                </table>
              </div>
              <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
                {data.rows.length} rows · generated {new Date().toLocaleString()}
              </p>
            </>
          )
        ) : null}
      </div>
    </div>
  );
}

export default function ReportsPage() {
  return (
    <Suspense>
      <ReportsContent />
    </Suspense>
  );
}
