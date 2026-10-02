"use client";

import { useApi } from "@/lib/client";
import { PageHeader, ErrorState, PageSpinner } from "@/components/app/states";
import { DataTable, type Column } from "@/components/app/data-table";
import { UserStatusBadge } from "@/components/app/badges";
import { formatCurrency } from "@/lib/utils";

interface EarningsRow {
  id: string;
  name: string;
  worker_code: string | null;
  team_name: string | null;
  status: string;
  delivered_commission: number;
  return_adjustment: number;
  manual_adjustment: number;
  net_commission: number;
  paid_amount: number;
  remaining_amount: number;
}

export default function WorkerEarningsPage() {
  const { data, loading, error, refresh } = useApi<{ rows: EarningsRow[] }>("/api/payments?view=earnings");

  const columns: Column<EarningsRow>[] = [
    {
      key: "name",
      header: "Worker",
      render: (w) => (
        <div>
          <p className="font-medium">{w.name}</p>
          <p className="text-xs text-muted-foreground">{w.worker_code ?? "—"} · {w.team_name ?? "No team"}</p>
        </div>
      ),
    },
    { key: "delivered_commission", header: "Delivered +", render: (w) => <span className="text-emerald-700">{formatCurrency(w.delivered_commission)}</span> },
    { key: "return_adjustment", header: "Returns −", render: (w) => <span className="text-rose-600">{formatCurrency(w.return_adjustment)}</span> },
    { key: "manual_adjustment", header: "Manual ±", render: (w) => formatCurrency(w.manual_adjustment), hideInCard: true },
    { key: "net_commission", header: "Net", render: (w) => <span className="font-semibold">{formatCurrency(w.net_commission)}</span> },
    { key: "paid_amount", header: "Paid", render: (w) => formatCurrency(w.paid_amount) },
    {
      key: "remaining_amount",
      header: "Remaining",
      render: (w) => (
        <span className={w.remaining_amount > 0 ? "font-semibold text-amber-600" : "font-semibold text-emerald-700"}>
          {formatCurrency(w.remaining_amount)}
        </span>
      ),
    },
    { key: "status", header: "Status", render: (w) => <UserStatusBadge status={w.status} />, hideInCard: true },
  ];

  if (loading) return <PageSpinner />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Worker Earnings"
        description="Derived live from the commission ledger — Net − Paid = Remaining"
      />
      <DataTable
        columns={columns}
        rows={data?.rows}
        loading={loading}
        emptyTitle="No workers yet"
        page={1}
        perPage={50}
        total={data?.rows.length ?? 0}
      />
    </div>
  );
}
