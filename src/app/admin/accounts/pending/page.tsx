"use client";

import { useState } from "react";
import { useApi, api } from "@/lib/client";
import { PageHeader, ErrorState, PageSpinner } from "@/components/app/states";
import { StatCard } from "@/components/app/stat-card";
import { FormDialog } from "@/components/app/form-dialog";
import { Button } from "@/components/ui/button";
import { formatCurrency, todayISO } from "@/lib/utils";
import { Wallet, Plus, Loader2 } from "lucide-react";

interface PendingRow {
  id: string;
  name: string;
  worker_code: string | null;
  net_commission: number;
  paid_amount: number;
  remaining_amount: number;
}

export default function PendingPaymentsPage() {
  const { data, loading, error, refresh } = useApi<{ rows: PendingRow[] }>("/api/payments?view=earnings");
  const [payOpen, setPayOpen] = useState(false);
  const [paying, setPaying] = useState<PendingRow | null>(null);

  if (loading) return <PageSpinner />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  const pending = (data?.rows ?? []).filter((w) => w.remaining_amount > 0);
  const totalPending = pending.reduce((s, w) => s + w.remaining_amount, 0);

  return (
    <div className="space-y-4">
      <PageHeader title="Pending Worker Payments" description="Net commission remaining to be settled" />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total pending" value={formatCurrency(totalPending)} icon={Wallet} tint="rose" loading={loading} />
        <StatCard label="Workers awaiting payment" value={pending.length} icon={Wallet} tint="amber" loading={loading} />
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {pending.length === 0 ? (
          <p className="px-4 py-12 text-center text-sm text-muted-foreground">
            No pending payments — every worker is fully settled.
          </p>
        ) : (
          <div className="divide-y divide-border/70">
            {pending.map((w) => (
              <div key={w.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
                <div className="min-w-0">
                  <p className="font-medium">{w.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {w.worker_code ?? "—"} · net {formatCurrency(w.net_commission)} · paid {formatCurrency(w.paid_amount)}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-semibold text-amber-600">{formatCurrency(w.remaining_amount)}</span>
                  <Button
                    size="sm"
                    onClick={() => {
                      setPaying(w);
                      setPayOpen(true);
                    }}
                  >
                    <Plus className="mr-1 h-3.5 w-3.5" /> Pay
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <FormDialog
        open={payOpen}
        onOpenChange={setPayOpen}
        title={paying ? `Pay ${paying.name}` : "Record payment"}
        fields={[
          { name: "amount", label: "Amount (Rs)", type: "number", required: true, min: 1, defaultValue: paying?.remaining_amount },
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
          { name: "reference", label: "Reference", type: "text" },
        ]}
        submitLabel="Record payment"
        onSubmit={async (v) => {
          if (!paying) return;
          await api("/api/payments", { method: "POST", json: { ...v, worker_id: paying.id, amount: Number(v.amount) } });
          refresh();
        }}
      />
    </div>
  );
}
