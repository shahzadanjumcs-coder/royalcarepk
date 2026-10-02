"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useList, buildQuery, useDebounced } from "@/lib/client";
import { PageHeader } from "@/components/app/states";
import { SearchInput } from "@/components/app/filters";
import { DataTable, type Column } from "@/components/app/data-table";
import { OrderStatusBadge, BookingStatusBadge } from "@/components/app/badges";
import { Button } from "@/components/ui/button";
import { cn, formatCurrency, formatDateTime } from "@/lib/utils";
import type { Order } from "@/lib/types";
import { ShoppingBag } from "lucide-react";

const TABS = [
  { key: "ALL", label: "All" },
  { key: "ASSIGNED", label: "To pack" },
  { key: "BOOKED", label: "Booked" },
  { key: "IN_TRANSIT", label: "In Transit" },
  { key: "DELIVERED", label: "Delivered" },
  { key: "RETURNED", label: "Returned" },
];

export default function WorkerOrdersPage() {
  const router = useRouter();
  const [status, setStatus] = useState("ALL");
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search);
  const [page, setPage] = useState(1);
  const { data, loading, error, refresh } = useList<Order>(
    `/api/orders${buildQuery({ status, search: debounced, page, perPage: 15 })}`,
    [status, debounced, page]
  );

  const columns: Column<Order>[] = useMemo(
    () => [
      {
        key: "order_number",
        header: "Order #",
        render: (o) => (
          <div>
            <p className="font-medium">{o.order_number}</p>
            <p className="text-xs text-muted-foreground">{formatDateTime(o.created_at)}</p>
          </div>
        ),
      },
      { key: "customer_name", header: "Customer", render: (o) => <div><p>{o.customer_name}</p><p className="text-xs text-muted-foreground">{o.customer_phone}</p></div> },
      { key: "city", header: "City", className: "text-muted-foreground", hideInCard: true },
      { key: "cod_amount", header: "COD", render: (o) => <span className="font-semibold">{formatCurrency(o.cod_amount)}</span> },
      { key: "status", header: "Status", render: (o) => <OrderStatusBadge status={o.status} /> },
      { key: "tracking_number", header: "CN", render: (o) => o.tracking_number ?? "—", hideInCard: true },
    ],
    []
  );

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader title="My Orders" description="Only orders assigned to you are visible here" />

      <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-thin" role="tablist">
        {TABS.map((t) => (
          <Button
            key={t.key}
            role="tab"
            aria-selected={status === t.key}
            size="sm"
            variant={status === t.key ? "default" : "outline"}
            className={cn("h-8 shrink-0 rounded-full px-3.5 text-xs", status !== t.key && "bg-card")}
            onClick={() => { setStatus(t.key); setPage(1); }}
          >
            {t.label}
          </Button>
        ))}
      </div>

      <DataTable
        columns={columns}
        rows={data?.rows}
        loading={loading}
        error={error}
        onRetry={refresh}
        emptyTitle="No orders here"
        emptyDescription="New assignments will appear automatically."
        emptyIcon={ShoppingBag}
        page={page}
        perPage={15}
        total={data?.total ?? 0}
        onPageChange={setPage}
        onRowClick={(o) => router.push(`/worker/orders/${o.id}`)}
        toolbar={<SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search order # or customer…" className="lg:w-80" />}
        mobileCard={(o) => (
          <button onClick={() => router.push(`/worker/orders/${o.id}`)} className="w-full rounded-xl border border-border bg-card p-4 text-left active:bg-muted/50">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold">{o.order_number}</p>
              <OrderStatusBadge status={o.status} />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{o.customer_name} · {o.customer_phone}</p>
            <p className="text-xs text-muted-foreground">{o.delivery_address}, {o.city}</p>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-sm font-bold">{formatCurrency(o.cod_amount)}</span>
              <BookingStatusBadge status={o.booking_status} />
            </div>
          </button>
        )}
      />
    </div>
  );
}
