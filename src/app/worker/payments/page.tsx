"use client";

import { useApi, useList, buildQuery } from "@/lib/client";
import { PageHeader, PageSpinner, ErrorState } from "@/components/app/states";
import { StatCard } from "@/components/app/stat-card";
import { DataTable, type Column } from "@/components/app/data-table";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { WorkerPayment } from "@/lib/types";
import { Wallet, CheckCircle2 } from "lucide-react";

export default function WorkerPaymentsPage() {
  const { data: summary, loading, error, refresh } = useApi<{
    worker: { earnings: { net_commission: number; paid_amount: number; remaining_amount: number } };
  }>("/api/worker/summary");
  const { data: payments, loading: pLoading } = useList<WorkerPayment>(`/api/payments${buildQuery({})}`);

  const columns: Column<WorkerPayment>[] = [
    { key: "payment_date", header: "Date", render: (p) => formatDate(p.payment_date) },
    { key: "amount", header: "Amount", render: (p) => <span className="font-semibold text-emerald-700">{formatCurrency(p.amount)}</span> },
    { key: "method", header: "Method", render: (p) => p.method.replace(/_/g, " ") },
    { key: "reference", header: "Reference", render: (p) => p.reference ?? "—", hideInCard: true },
    { key: "note", header: "Note", render: (p) => p.note ?? "—", hideInCard: true },
  ];

  if (loading) return <PageSpinner />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;
  if (!summary) return null;
  const e = summary.worker.earnings;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader title="My Payments" description="Payments recorded by the admin against your net commission" />

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Net Commission" value={formatCurrency(e.net_commission)} icon={Wallet} tint="teal" loading={loading} />
        <StatCard label="Paid" value={formatCurrency(e.paid_amount)} icon={CheckCircle2} tint="emerald" loading={loading} />
        <StatCard label="Remaining" value={formatCurrency(e.remaining_amount)} icon={Wallet} tint="amber" loading={loading} />
      </section>

      <div className="rounded-xl border border-border bg-card p-4">
        <h3 className="mb-3 text-sm font-semibold">Payment history</h3>
        <DataTable
          columns={columns}
          rows={payments?.rows}
          loading={pLoading}
          emptyTitle="No payments yet"
          emptyDescription="When the admin records a payment it appears here instantly."
          page={1}
          perPage={20}
          total={payments?.total ?? 0}
        />
      </div>
    </div>
  );
}
