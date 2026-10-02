"use client";

import { useState } from "react";
import { useList, buildQuery, useDebounced, usePagination } from "@/lib/client";
import { PageHeader } from "@/components/app/states";
import { DataTable, type Column } from "@/components/app/data-table";
import { CommissionTypeBadge } from "@/components/app/badges";
import { SearchInput } from "@/components/app/filters";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { CommissionTransaction } from "@/lib/types";
import { ScrollText } from "lucide-react";

export default function AccountTransactionsPage() {
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search);
  const { page, setPage } = usePagination(20);
  const { data, loading, error, refresh } = useList<CommissionTransaction>(
    `/api/commission${buildQuery({ search: debounced, page, perPage: 20 })}`,
    [debounced, page]
  );

  const columns: Column<CommissionTransaction>[] = [
    { key: "created_at", header: "Date", render: (t) => formatDate(t.created_at) },
    { key: "worker_name", header: "Worker" },
    { key: "order_number", header: "Order #", render: (t) => t.order_number ?? "—" },
    { key: "type", header: "Type", render: (t) => <CommissionTypeBadge type={t.type} /> },
    { key: "description", header: "Description", render: (t) => <span className="text-xs text-muted-foreground">{t.description ?? "—"}</span>, hideInCard: true },
    {
      key: "amount",
      header: "Amount",
      render: (t) => (
        <span className={t.amount >= 0 ? "font-semibold text-emerald-700" : "font-semibold text-rose-600"}>
          {formatCurrency(t.amount)}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Commission Transactions" description="Read-only ledger — the single source of truth for worker balances" />
      <DataTable
        columns={columns}
        rows={data?.rows}
        loading={loading}
        error={error}
        onRetry={refresh}
        emptyTitle="No transactions"
        emptyIcon={ScrollText}
        page={page}
        perPage={20}
        total={data?.total ?? 0}
        onPageChange={setPage}
        toolbar={<SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search description…" className="lg:w-80" />}
      />
    </div>
  );
}
