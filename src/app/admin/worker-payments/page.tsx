"use client";

import { useState } from "react";
import { useApi, api, buildQuery, useList } from "@/lib/client";
import { PageHeader } from "@/components/app/states";
import { DataTable, type Column } from "@/components/app/data-table";
import { FormDialog } from "@/components/app/form-dialog";
import { StatCard } from "@/components/app/stat-card";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate, todayISO } from "@/lib/utils";
import type { WorkerPayment } from "@/lib/types";
import { Wallet, Plus } from "lucide-react";

export default function WorkerPaymentsPage() {
  const [payOpen, setPayOpen] = useState(false);
  const { data: payments, loading, error, refresh } = useList<WorkerPayment>(`/api/payments${buildQuery({})}`);
  const { data: workers } = useApi<{ rows: { id: string; name: string; remaining_amount: number }[] }>("/api/payments?view=earnings");

  const totalPaid = (payments?.rows ?? []).reduce((s, p) => s + p.amount, 0);

  const columns: Column<WorkerPayment>[] = [
    { key: "payment_date", header: "Date", render: (p) => formatDate(p.payment_date) },
    { key: "worker_name", header: "Worker", render: (p) => <span className="font-medium">{p.worker_name}</span> },
    { key: "amount", header: "Amount", render: (p) => <span className="font-semibold text-emerald-700">{formatCurrency(p.amount)}</span> },
    { key: "method", header: "Method", render: (p) => p.method.replace(/_/g, " ") },
    { key: "reference", header: "Reference", render: (p) => p.reference ?? "—", hideInCard: true },
    { key: "note", header: "Note", render: (p) => p.note ?? "—", hideInCard: true },
    { key: "created_by_name", header: "Recorded by", render: (p) => p.created_by_name ?? "—", hideInCard: true },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Worker Payments"
        description="Record payments against net commission — the ledger is never modified by payments"
        actions={
          <Button onClick={() => setPayOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> Record payment
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total paid (history)" value={formatCurrency(totalPaid)} icon={Wallet} tint="emerald" loading={loading} />
        <StatCard label="Payments recorded" value={payments?.total ?? 0} icon={Wallet} tint="slate" loading={loading} />
      </div>

      <DataTable
        columns={columns}
        rows={payments?.rows}
        loading={loading}
        error={error}
        onRetry={refresh}
        emptyTitle="No payments recorded"
        emptyDescription="Record the first payment to a worker."
        emptyIcon={Wallet}
        page={1}
        perPage={25}
        total={payments?.total ?? 0}
      />

      <FormDialog
        open={payOpen}
        onOpenChange={setPayOpen}
        title="Record worker payment"
        fields={[
          {
            name: "worker_id",
            label: "Worker",
            type: "select",
            required: true,
            options: (workers?.rows ?? []).map((w) => ({
              value: w.id,
              label: `${w.name} — remaining ${formatCurrency(w.remaining_amount)}`,
            })),
          },
          { name: "amount", label: "Amount (Rs)", type: "number", required: true, min: 1 },
          {
            name: "method",
            label: "Method",
            type: "select",
            required: true,
            defaultValue: "CASH",
            options: [
              { value: "CASH", label: "Cash" },
              { value: "BANK_TRANSFER", label: "Bank Transfer" },
              { value: "OTHER", label: "Other" },
            ],
          },
          { name: "payment_date", label: "Date", type: "date", required: true, defaultValue: todayISO() },
          { name: "reference", label: "Reference", type: "text", placeholder: "TRX / slip number" },
          { name: "note", label: "Note", type: "textarea" },
        ]}
        submitLabel="Record payment"
        onSubmit={async (v) => {
          await api("/api/payments", { method: "POST", json: { ...v, amount: Number(v.amount) } });
          refresh();
        }}
      />
    </div>
  );
}
