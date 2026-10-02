"use client";

import { use } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/lib/client";
import { PageHeader, PageSpinner, ErrorState } from "@/components/app/states";
import { OrderStatusBadge } from "@/components/app/badges";
import { DataTable, type Column } from "@/components/app/data-table";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import { ArrowLeft } from "lucide-react";

interface CustomerData {
  customer: {
    id: string;
    name: string;
    phone: string;
    email: string | null;
    address: string | null;
    city: string | null;
    status: string;
    notes: string | null;
    created_at: string;
  };
  stats: { total_orders: number; delivered_orders: number; returned_orders: number; total_spending: number };
  orders: { id: string; order_number: string; status: string; total: number; created_at: string }[];
}

export default function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data, loading, error, refresh } = useApi<CustomerData>(`/api/customers/${id}`);

  if (loading) return <PageSpinner />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;
  if (!data) return null;
  const { customer: c, stats } = data;

  const columns: Column<CustomerData["orders"][number]>[] = [
    { key: "order_number", header: "Order #", render: (o) => <span className="font-medium">{o.order_number}</span> },
    { key: "total", header: "COD", render: (o) => formatCurrency(o.total) },
    { key: "status", header: "Status", render: (o) => <OrderStatusBadge status={o.status} /> },
    { key: "created_at", header: "Date", render: (o) => formatDateTime(o.created_at), hideInCard: true },
  ];

  const stat = (label: string, value: string, cls = "") => (
    <div className="rounded-lg border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold ${cls}`}>{value}</p>
    </div>
  );

  return (
    <div className="space-y-5">
      <Button variant="ghost" size="sm" onClick={() => router.push("/admin/customers")}>
        <ArrowLeft className="mr-1 h-4 w-4" /> Customers
      </Button>

      <PageHeader
        title={c.name}
        description={`${c.phone}${c.email ? ` · ${c.email}` : ""} · ${c.city ?? "—"} · Customer since ${formatDateTime(c.created_at)}`}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stat("Total orders", String(stats.total_orders))}
        {stat("Delivered", String(stats.delivered_orders), "text-emerald-700")}
        {stat("Returned", String(stats.returned_orders), "text-rose-600")}
        {stat("Total spending", formatCurrency(stats.total_spending))}
      </div>

      <Card>
        <CardContent className="grid gap-3 p-4 text-sm sm:grid-cols-2">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Address</p>
            <p className="mt-1 text-muted-foreground">{c.address ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Notes</p>
            <p className="mt-1 text-muted-foreground">{c.notes ?? "—"}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <h3 className="mb-3 text-sm font-semibold">Order history</h3>
          <DataTable
            columns={columns}
            rows={data.orders}
            emptyTitle="No orders yet"
            page={1}
            perPage={25}
            total={data.orders.length}
            onRowClick={(o) => router.push(`/admin/orders/${o.id}`)}
          />
        </CardContent>
      </Card>
    </div>
  );
}
