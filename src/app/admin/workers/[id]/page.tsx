"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { api, useApi, ApiError } from "@/lib/client";
import { PageHeader, PageSpinner, ErrorState } from "@/components/app/states";
import { UserStatusBadge } from "@/components/app/badges";
import { DataTable, type Column } from "@/components/app/data-table";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FormDialog } from "@/components/app/form-dialog";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { WorkerDetail } from "@/lib/services/workers";
import { ArrowLeft, Pencil } from "lucide-react";

export default function WorkerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data, loading, error, refresh } = useApi<{ worker: WorkerDetail }>(`/api/workers/${id}`);
  const [editOpen, setEditOpen] = useState(false);

  if (loading) return <PageSpinner />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;
  if (!data) return null;
  const w = data.worker;
  const e = w.earnings;

  const columns: Column<WorkerDetail["recent_orders"][number]>[] = [
    { key: "order_number", header: "Order #", render: (o) => <span className="font-medium">{o.order_number}</span> },
    { key: "customer_name", header: "Customer" },
    { key: "total", header: "COD", render: (o) => formatCurrency(o.total) },
    { key: "status", header: "Status", render: (o) => <span className="text-xs font-medium">{o.status}</span> },
    { key: "tracking_number", header: "CN", render: (o) => o.tracking_number ?? "—", hideInCard: true },
    { key: "created_at", header: "Date", render: (o) => formatDate(o.created_at), hideInCard: true },
  ];

  const stat = (label: string, value: string, cls = "") => (
    <div className="rounded-lg border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold ${cls}`}>{value}</p>
    </div>
  );

  return (
    <div className="space-y-5">
      <Button variant="ghost" size="sm" onClick={() => router.push("/admin/workers")}>
        <ArrowLeft className="mr-1 h-4 w-4" /> Workers
      </Button>

      <PageHeader
        title={w.name}
        description={`${w.worker_code ?? "—"} · ${w.email} · ${w.phone} · ${w.team_name ?? "No team"}`}
        actions={
          <div className="flex items-center gap-2">
            <UserStatusBadge status={w.status} />
            <Button variant="outline" onClick={() => setEditOpen(true)}>
              <Pencil className="mr-1.5 h-4 w-4" /> Edit
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {stat("Total orders", String(w.performance.total_orders))}
        {stat("Delivered", String(w.performance.delivered), "text-emerald-700")}
        {stat("Returned", String(w.performance.returned), "text-rose-600")}
        {stat("Success rate", w.performance.success_rate)}
        {stat("Delivered value", formatCurrency(w.performance.total_cod))}
        {stat("Commission rate", `${w.commission_rate}%`)}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Earnings ledger summary</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          {stat("Delivered commission", formatCurrency(e.delivered_commission), "text-emerald-700")}
          {stat("Return adjustments", formatCurrency(e.return_adjustment), "text-rose-600")}
          {stat("Manual adjustments", formatCurrency(e.manual_adjustment))}
          {stat("Net commission", formatCurrency(e.net_commission))}
          {stat("Paid", formatCurrency(e.paid_amount))}
          {stat("Remaining", formatCurrency(e.remaining_amount), e.remaining_amount > 0 ? "text-amber-600" : "text-emerald-700")}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Recent orders</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            rows={w.recent_orders}
            emptyTitle="No orders assigned yet"
            page={1}
            perPage={20}
            total={w.recent_orders.length}
          />
        </CardContent>
      </Card>

      <FormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        title={`Edit ${w.name}`}
        fields={[
          { name: "name", label: "Full name", type: "text", required: true, defaultValue: w.name },
          { name: "phone", label: "Phone", type: "tel", defaultValue: w.phone },
          { name: "commission_rate", label: "Commission rate (%)", type: "number", min: 0, max: 100, step: "0.5", defaultValue: w.commission_rate, hint: "Only affects future assignments — locked rates on existing orders never change." },
          { name: "status", label: "Account status", type: "select", defaultValue: w.status, options: [
            { value: "active", label: "Active" },
            { value: "disabled", label: "Disabled (cannot sign in)" },
          ] },
        ]}
        onSubmit={async (values) => {
          await api(`/api/workers/${id}`, { method: "PATCH", json: values });
          refresh();
        }}
      />
    </div>
  );
}
