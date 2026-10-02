"use client";

import { useState } from "react";
import { useList, buildQuery, useDebounced } from "@/lib/client";
import { PageHeader } from "@/components/app/states";
import { SearchInput } from "@/components/app/filters";
import { DataTable, type Column } from "@/components/app/data-table";
import { MovementBadge } from "@/components/app/badges";
import { Button } from "@/components/ui/button";
import { cn, formatDateTime } from "@/lib/utils";
import type { InventoryMovement } from "@/lib/types";
import { ScrollText } from "lucide-react";

const TYPES = ["ALL", "PURCHASE", "STOCK_IN", "STOCK_OUT", "ORDER_RESERVE", "ORDER_RELEASE", "DELIVERY", "RETURN", "ADJUSTMENT"];

export default function StockHistoryPage() {
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search);
  const [type, setType] = useState("ALL");
  const [page, setPage] = useState(1);
  const { data, loading, error, refresh } = useList<InventoryMovement>(
    `/api/inventory/movements${buildQuery({ search: debounced, page, perPage: 20, f_type: type === "ALL" ? undefined : type })}`,
    [debounced, type, page]
  );

  const columns: Column<InventoryMovement>[] = [
    { key: "created_at", header: "When", render: (m) => <span className="whitespace-nowrap text-xs">{formatDateTime(m.created_at)}</span> },
    {
      key: "product",
      header: "Product",
      render: (m) => (
        <div>
          <p className="font-medium">{m.product_name}</p>
          <p className="text-xs text-muted-foreground">{m.product_sku}</p>
        </div>
      ),
    },
    { key: "type", header: "Type", render: (m) => <MovementBadge type={m.type} /> },
    {
      key: "quantity",
      header: "Stock Δ",
      render: (m) => (
        <span className={cn("font-semibold", m.quantity > 0 ? "text-emerald-700" : m.quantity < 0 ? "text-rose-600" : "text-muted-foreground")}>
          {m.quantity > 0 ? "+" : ""}{m.quantity}
        </span>
      ),
    },
    {
      key: "reserved_change",
      header: "Reserved Δ",
      render: (m) => (
        <span className={cn(m.reserved_change > 0 ? "text-amber-600" : m.reserved_change < 0 ? "text-sky-700" : "text-muted-foreground")}>
          {m.reserved_change > 0 ? "+" : ""}{m.reserved_change}
        </span>
      ),
    },
    { key: "balance_after", header: "Balance", render: (m) => <span className="text-xs">{m.balance_after} on hand / {m.reserved_after} reserved</span>, hideInCard: true },
    { key: "order_number", header: "Order", render: (m) => (m.order_number ? <span className="font-mono text-xs">{m.order_number}</span> : "—"), hideInCard: true },
    { key: "created_by_name", header: "By", render: (m) => m.created_by_name ?? "system", hideInCard: true },
    { key: "note", header: "Note", render: (m) => <span className="text-xs text-muted-foreground">{m.note ?? "—"}</span>, hideInCard: true },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Stock History" description="Full movement ledger — every change is traceable" />

      <DataTable
        columns={columns}
        rows={data?.rows}
        loading={loading}
        error={error}
        onRetry={refresh}
        emptyTitle="No movements yet"
        emptyIcon={ScrollText}
        page={page}
        perPage={20}
        total={data?.total ?? 0}
        onPageChange={setPage}
        toolbar={
          <div className="space-y-2">
            <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search note…" className="lg:w-80" />
            <div className="flex flex-wrap gap-1.5">
              {TYPES.map((t) => (
                <Button
                  key={t}
                  size="sm"
                  variant={type === t ? "default" : "outline"}
                  className="h-7 rounded-full px-2.5 text-[11px]"
                  onClick={() => { setType(t); setPage(1); }}
                >
                  {t === "ALL" ? "All" : t.replace(/_/g, " ")}
                </Button>
              ))}
            </div>
          </div>
        }
      />
    </div>
  );
}
