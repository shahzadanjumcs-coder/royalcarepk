"use client";

import { useList, buildQuery } from "@/lib/client";
import { PageHeader } from "@/components/app/states";
import { DataTable, type Column } from "@/components/app/data-table";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { WorkerPayment } from "@/lib/types";
import { Wallet } from "lucide-react";

export default function AccountPaymentsPage() {
  const { data, loading, error, refresh } = useList<WorkerPayment>(`/api/payments${buildQuery({})}`);

  const columns: Column<WorkerPayment>[] = [
    { key: "payment_date", header: "Date", render: (p) => formatDate(p.payment_date) },
    { key: "worker_name", header: "Worker", render: (p) => <span className="font-medium">{p.worker_name}</span> },
    { key: "amount", header: "Amount", render: (p) => <span className="font-semibold text-emerald-700">{formatCurrency(p.amount)}</span> },
    { key: "method", header: "Method", render: (p) => p.method.replace(/_/g, " ") },
    { key: "reference", header: "Reference", render: (p) => p.reference ?? "—", hideInCard: true },
    { key: "note", header: "Note", render: (p) => p.note ?? "—", hideInCard: true },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Payments" description="Complete payment history across all workers" />
      <DataTable
        columns={columns}
        rows={data?.rows}
        loading={loading}
        error={error}
        onRetry={refresh}
        emptyTitle="No payments yet"
        emptyIcon={Wallet}
        page={1}
        perPage={25}
        total={data?.total ?? 0}
      />
    </div>
  );
}
