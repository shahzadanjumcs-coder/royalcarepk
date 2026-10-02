"use client";

import { useState } from "react";
import { useApi, api, buildQuery, useDebounced, useList } from "@/lib/client";
import { PageHeader } from "@/components/app/states";
import { DataTable, type Column } from "@/components/app/data-table";
import { CommissionTypeBadge } from "@/components/app/badges";
import { FormDialog } from "@/components/app/form-dialog";
import { Button } from "@/components/ui/button";
import { usePagination } from "@/lib/client";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { CommissionTransaction } from "@/lib/types";
import { PercentCircle, Plus } from "lucide-react";

export default function CommissionPage() {
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search);
  const [type, setType] = useState("ALL");
  const [adjustOpen, setAdjustOpen] = useState(false);
  const { page, setPage } = usePagination(15);

  const { data: txns, loading, error, refresh } = useList<CommissionTransaction>(
    `/api/commission${buildQuery({ search: debounced, type, page, perPage: 15 })}`,
    [debounced, type, page]
  );

  const { data: workers } = useApi<{ rows: { id: string; name: string; worker_code: string | null }[] }>("/api/workers?perPage=100");

  const columns: Column<CommissionTransaction>[] = [
    { key: "created_at", header: "Date", render: (t) => formatDate(t.created_at) },
    { key: "worker_name", header: "Worker", render: (t) => <span className="font-medium">{t.worker_name}</span> },
    { key: "order_number", header: "Order #", render: (t) => t.order_number ?? "—" },
    { key: "type", header: "Type", render: (t) => <CommissionTypeBadge type={t.type} /> },
    { key: "rate", header: "Rate", render: (t) => (t.rate ? `${t.rate}%` : "—"), hideInCard: true },
    { key: "cod_amount", header: "COD", render: (t) => (t.cod_amount ? formatCurrency(t.cod_amount) : "—"), hideInCard: true },
    {
      key: "amount",
      header: "Amount",
      render: (t) => (
        <span className={t.amount >= 0 ? "font-semibold text-emerald-700" : "font-semibold text-rose-600"}>
          {formatCurrency(t.amount)}
        </span>
      ),
    },
    { key: "description", header: "Description", render: (t) => <span className="text-xs text-muted-foreground">{t.description ?? "—"}</span>, hideInCard: true },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Commission Ledger"
        description="Every credit, deduction and manual adjustment — balances are always derived from this ledger"
        actions={
          <Button onClick={() => setAdjustOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> Manual adjustment
          </Button>
        }
      />

      <DataTable
        columns={columns}
        rows={txns?.rows}
        loading={loading}
        error={error}
        onRetry={refresh}
        emptyTitle="No commission transactions"
        emptyDescription="Credits appear automatically when orders are delivered."
        emptyIcon={PercentCircle}
        page={page}
        perPage={15}
        total={txns?.total ?? 0}
        onPageChange={setPage}
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            {["ALL", "DELIVERED_COMMISSION", "RETURN_ADJUSTMENT", "MANUAL_ADJUSTMENT"].map((t) => (
              <Button
                key={t}
                size="sm"
                variant={type === t ? "default" : "outline"}
                className="h-8 rounded-full px-3 text-xs"
                onClick={() => { setType(t); setPage(1); }}
              >
                {t === "ALL" ? "All" : t.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())}
              </Button>
            ))}
          </div>
        }
      />

      <FormDialog
        open={adjustOpen}
        onOpenChange={setAdjustOpen}
        title="Manual commission adjustment"
        description="Add a positive (bonus) or negative (correction) amount. It is appended to the ledger, never overwriting it."
        fields={[
          { name: "worker_id", label: "Worker", type: "select", required: true, options: (workers?.rows ?? []).map((w) => ({ value: w.id, label: w.name })) },
          { name: "amount", label: "Amount (use negative to deduct)", type: "number", required: true, step: "1" },
          { name: "description", label: "Description", type: "text", required: true, placeholder: "Why is this adjustment being made?" },
        ]}
        submitLabel="Post adjustment"
        onSubmit={async (v) => {
          await api("/api/commission/adjustments", { method: "POST", json: { ...v, amount: Number(v.amount) } });
          refresh();
        }}
      />
    </div>
  );
}
