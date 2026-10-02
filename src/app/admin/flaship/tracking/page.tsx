"use client";

import { useState } from "react";
import Link from "next/link";
import { api, useApi, useList, buildQuery, ApiError } from "@/lib/client";
import { PageHeader, ErrorState } from "@/components/app/states";
import { DataTable, type Column } from "@/components/app/data-table";
import { OrderStatusBadge } from "@/components/app/badges";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDateTime, timeAgo } from "@/lib/utils";
import type { Order } from "@/lib/types";
import { Radar, Loader2, RefreshCw } from "lucide-react";

export default function FlashipTrackingPage() {
  const [page, setPage] = useState(1);
  const { data, loading, error, refresh } = useList<Order>(
    `/api/orders${buildQuery({ status: "BOOKED", page, perPage: 15 })}`,
    [page]
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);

  const sync = async (order: Order) => {
    setBusyId(order.id);
    setMessage(null);
    try {
      const res = await api<{ message: string }>(`/api/orders/${order.id}/sync`, { method: "POST" });
      setMessage({ kind: "ok", text: `${order.order_number}: ${res.message}` });
      refresh();
    } catch (e) {
      setMessage({ kind: "err", text: e instanceof ApiError ? e.message : "Sync failed." });
    } finally {
      setBusyId(null);
    }
  };

  const syncAll = async () => {
    setSyncingAll(true);
    setMessage(null);
    let ok = 0;
    let failed = 0;
    for (const o of (data?.rows ?? []).slice(0, 10)) {
      try {
        await api(`/api/orders/${o.id}/sync`, { method: "POST" });
        ok++;
      } catch {
        failed++;
      }
    }
    setMessage({ kind: failed ? "err" : "ok", text: `Bulk sync finished — ${ok} updated, ${failed} failed.` });
    setSyncingAll(false);
    refresh();
  };

  const columns: Column<Order>[] = [
    {
      key: "order_number",
      header: "Order",
      render: (o) => (
        <div>
          <Link href={`/admin/orders/${o.id}`} className="font-medium text-emerald-800 hover:underline">{o.order_number}</Link>
          <p className="text-xs text-muted-foreground">{formatDateTime(o.booked_at)}</p>
        </div>
      ),
    },
    { key: "tracking_number", header: "CN", render: (o) => <span className="font-mono text-xs">{o.tracking_number}</span> },
    { key: "flaship_courier_name", header: "Courier", hideInCard: true },
    { key: "city", header: "Destination" },
    { key: "cod_amount", header: "COD", render: (o) => formatCurrency(o.cod_amount), hideInCard: true },
    { key: "status", header: "Status", render: (o) => <OrderStatusBadge status={o.status} /> },
    { key: "last_synced_at", header: "Last sync", render: (o) => <span className="text-xs text-muted-foreground">{o.last_synced_at ? timeAgo(o.last_synced_at) : "never"}</span>, hideInCard: true },
    {
      key: "actions",
      header: "",
      render: (o) => (
        <Button size="sm" variant="outline" disabled={busyId === o.id} onClick={() => void sync(o)}>
          {busyId === o.id ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Radar className="mr-1.5 h-3.5 w-3.5" />}
          Sync
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Flaship Tracking"
        description="Pull the latest checkpoints and let status changes flow into commissions & stock automatically"
        actions={
          <Button onClick={syncAll} disabled={syncingAll || loading}>
            {syncingAll ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}
            Sync visible (10)
          </Button>
        }
      />

      {message ? (
        <div
          className={message.kind === "ok"
            ? "rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
            : "rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"}
        >
          {message.text}
        </div>
      ) : null}

      {error ? (
        <ErrorState message={error} onRetry={refresh} />
      ) : (
        <DataTable
          columns={columns}
          rows={data?.rows}
          loading={loading}
          emptyTitle="No booked orders"
          emptyDescription="Book orders from the Flaship Booking console first."
          page={page}
          perPage={15}
          total={data?.total ?? 0}
          onPageChange={setPage}
        />
      )}
    </div>
  );
}
