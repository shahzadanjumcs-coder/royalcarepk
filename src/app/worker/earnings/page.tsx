"use client";

import { useState } from "react";
import { useApi, useList, buildQuery } from "@/lib/client";
import { PageHeader, PageSpinner, ErrorState } from "@/components/app/states";
import { StatCard } from "@/components/app/stat-card";
import { DataTable, type Column } from "@/components/app/data-table";
import { CommissionTypeBadge } from "@/components/app/badges";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { CommissionTransaction } from "@/lib/types";
import { PercentCircle, RotateCcw, Wallet, CheckCircle2 } from "lucide-react";

export default function WorkerEarningsPage() {
  const { data, loading, error, refresh } = useApi<{
    worker: {
      name: string;
      worker_code: string | null;
      earnings: { delivered_commission: number; return_adjustment: number; manual_adjustment: number; net_commission: number; paid_amount: number; remaining_amount: number };
    };
  }>("/api/worker/summary");
  const { data: txns, loading: tLoading } = useList<CommissionTransaction>(`/api/commission${buildQuery({ perPage: 20 })}`);

  const columns: Column<CommissionTransaction>[] = [
    { key: "created_at", header: "Date", render: (t) => formatDate(t.created_at) },
    { key: "order_number", header: "Order #", render: (t) => t.order_number ?? "—" },
    { key: "type", header: "Type", render: (t) => <CommissionTypeBadge type={t.type} /> },
    {
      key: "amount",
      header: "Amount",
      render: (t) => (
        <span className={t.amount >= 0 ? "font-semibold text-emerald-700" : "font-semibold text-rose-600"}>
          {formatCurrency(t.amount)}
        </span>
      ),
    },
    { key: "description", header: "Detail", render: (t) => <span className="text-xs text-muted-foreground">{t.description ?? "—"}</span>, hideInCard: true },
  ];

  if (loading) return <PageSpinner />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;
  if (!data) return null;
  const e = data.worker.earnings;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader title="My Earnings" description="Every rupee is traceable to a ledger entry — nothing is hidden or overwritten" />

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Delivered Commission" value={formatCurrency(e.delivered_commission)} icon={PercentCircle} tint="emerald" loading={loading} />
        <StatCard label="Return Adjustments" value={formatCurrency(e.return_adjustment)} icon={RotateCcw} tint="rose" loading={loading} />
        <StatCard label="Manual Adjustments" value={formatCurrency(e.manual_adjustment)} icon={Wallet} tint="amber" loading={loading} />
        <StatCard label="Net Commission" value={formatCurrency(e.net_commission)} icon={Wallet} tint="teal" loading={loading} />
      </section>
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-2">
        <StatCard label="Paid" value={formatCurrency(e.paid_amount)} icon={CheckCircle2} tint="teal" loading={loading} />
        <StatCard label="Remaining" value={formatCurrency(e.remaining_amount)} icon={Wallet} tint="amber" loading={loading} />
      </section>

      <div className="rounded-xl border border-border bg-card p-4">
        <h3 className="mb-3 text-sm font-semibold">Ledger entries</h3>
        <DataTable
          columns={columns}
          rows={txns?.rows}
          loading={tLoading}
          emptyTitle="No ledger entries yet"
          page={1}
          perPage={20}
          total={txns?.total ?? 0}
        />
      </div>
    </div>
  );
}
