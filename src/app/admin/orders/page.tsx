"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useList, buildQuery, useDebounced } from "@/lib/client";
import { PageHeader } from "@/components/app/states";
import { SearchInput, RangeFilter } from "@/components/app/filters";
import { DataTable, type Column } from "@/components/app/data-table";
import { OrderStatusBadge, BookingStatusBadge } from "@/components/app/badges";
import { Button } from "@/components/ui/button";
import { cn, formatCurrency, formatDateTime } from "@/lib/utils";
import type { Order } from "@/lib/types";
import { Plus, ShoppingBag } from "lucide-react";

const STATUS_TABS = [
  { key: "ALL", label: "All" },
  { key: "PENDING", label: "Pending" },
  { key: "BOOKED", label: "Booked" },
  { key: "IN_TRANSIT", label: "In Transit" },
  { key: "DELIVERED", label: "Delivered" },
  { key: "RETURNED", label: "Returned" },
  { key: "CANCELLED", label: "Cancelled" },
];

function OrdersContent() {
  const params = useSearchParams();
  const router = useRouter();
  const status = params.get("status") ?? "ALL";
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search);
  const [preset, setPreset] = useState("all");
  const [range, setRange] = useState<{ preset: string; from?: string; to?: string }>({ preset: "all" });
  const [page, setPage] = useState(1);

  const query = buildQuery({
    status,
    search: debounced,
    page,
    perPage: 15,
    preset: range.preset,
    from: range.preset === "custom" ? range.from : undefined,
    to: range.preset === "custom" ? range.to : undefined,
  });
  const { data, loading, error, refresh } = useList<Order>(`/api/orders${query}`, [status, debounced, preset, range.from, range.to, page]);

  const columns: Column<Order>[] = useMemo(
    () => [
      {
        key: "order_number",
        header: "Order #",
        render: (o) => (
          <div>
            <p className="font-medium text-foreground">{o.order_number}</p>
            <p className="text-xs text-muted-foreground">{formatDateTime(o.created_at)}</p>
          </div>
        ),
      },
      {
        key: "customer",
        header: "Customer",
        render: (o) => (
          <div>
            <p>{o.customer_name}</p>
            <p className="text-xs text-muted-foreground">{o.customer_phone}</p>
          </div>
        ),
      },
      { key: "city", header: "City", className: "text-muted-foreground" },
      {
        key: "worker",
        header: "Worker",
        render: (o) => o.worker_name ?? <span className="text-muted-foreground">Unassigned</span>,
      },
      {
        key: "cod_amount",
        header: "COD",
        render: (o) => <span className="font-semibold">{formatCurrency(o.cod_amount)}</span>,
      },
      { key: "status", header: "Status", render: (o) => <OrderStatusBadge status={o.status} /> },
      { key: "booking_status", header: "Booking", render: (o) => <BookingStatusBadge status={o.booking_status} />, hideInCard: true },
      {
        key: "tracking_number",
        header: "CN",
        render: (o) => o.tracking_number ?? <span className="text-muted-foreground">—</span>,
        hideInCard: true,
      },
    ],
    []
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Orders"
        description="Create, book, track and settle COD orders"
        actions={
          <Button asChild>
            <Link href="/admin/orders/new">
              <Plus className="mr-1.5 h-4 w-4" /> New Order
            </Link>
          </Button>
        }
      />

      {/* Status tabs */}
      <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-thin no-print" role="tablist" aria-label="Order status filter">
        {STATUS_TABS.map((t) => (
          <Button
            key={t.key}
            role="tab"
            aria-selected={status === t.key}
            size="sm"
            variant={status === t.key ? "default" : "outline"}
            className={cn("h-8 shrink-0 rounded-full px-3.5 text-xs", status !== t.key && "bg-card")}
            onClick={() => {
              setPage(1);
              router.replace(t.key === "ALL" ? "/admin/orders" : `/admin/orders?status=${t.key}`);
            }}
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
        emptyTitle="No orders found"
        emptyDescription="Try changing filters, or create your first order."
        emptyIcon={ShoppingBag}
        page={page}
        perPage={15}
        total={data?.total ?? 0}
        onPageChange={setPage}
        toolbar={
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
            <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search order #, city, CN…" className="lg:w-80" />
            <RangeFilter value={range} onChange={(v) => { setRange(v); setPage(1); }} />
          </div>
        }
        onRowClick={(o) => router.push(`/admin/orders/${o.id}`)}
        mobileCard={(o) => (
          <button
            onClick={() => router.push(`/admin/orders/${o.id}`)}
            className="w-full rounded-xl border border-border bg-card p-4 text-left active:bg-muted/50"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold">{o.order_number}</p>
              <OrderStatusBadge status={o.status} />
            </div>
            <div className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
              <p>{o.customer_name} · {o.customer_phone}</p>
              <p>{o.city} · {o.worker_name ?? "Unassigned"}</p>
              <p>{formatDateTime(o.created_at)}</p>
            </div>
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

export default function OrdersPage() {
  return (
    <Suspense>
      <OrdersContent />
    </Suspense>
  );
}
