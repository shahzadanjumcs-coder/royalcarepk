"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { api, useApi, useList, buildQuery, ApiError } from "@/lib/client";
import { PageHeader, PageSpinner, ErrorState } from "@/components/app/states";
import { DataTable, type Column } from "@/components/app/data-table";
import { OrderStatusBadge, BookingStatusBadge } from "@/components/app/badges";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import type { Order } from "@/lib/types";
import { BookOpen, RefreshCw, Send, Loader2, Info } from "lucide-react";

interface CatalogCarrier { id: string; courier_id: string; name: string }
interface CatalogPickup { id: string; pickup_id: string; name: string; address: string | null }

export default function FlashipBookingPage() {
  const [page, setPage] = useState(1);
  const { data: cfg } = useApi<{ mode: string; api_key_set: boolean }>("/api/flaship/catalog");
  const { data: catalog } = useApi<{ couriers: CatalogCarrier[]; pickups: CatalogPickup[] }>("/api/flaship/catalog");
  const { data, loading, error, refresh } = useList<Order>(
    `/api/orders${buildQuery({ status: "UNBOOKED", approval: "APPROVED", page, perPage: 15 })}`,
    [page]
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [courier, setCourier] = useState("");
  const [serviceType, setServiceType] = useState("overnight");
  const [pickup, setPickup] = useState("");

  const bookable = useMemo(() => (data?.rows ?? []).filter((o) => o.booking_status !== "booked"), [data]);

  const book = async (order: Order) => {
    setBusyId(order.id);
    setMessage(null);
    try {
      const res = await api<{ trackingNumber: string; courierName: string }>(`/api/orders/${order.id}/book`, {
        method: "POST",
        json: {
          ...(courier ? { courier } : {}),
          ...(pickup ? { pickup } : {}),
          service_type: serviceType,
        },
      });
      setMessage({ kind: "ok", text: `${order.order_number} booked with ${res.courierName} — CN ${res.trackingNumber}` });
      refresh();
    } catch (e) {
      setMessage({ kind: "err", text: e instanceof ApiError ? e.message : "Booking failed." });
    } finally {
      setBusyId(null);
    }
  };

  const columns: Column<Order>[] = [
    {
      key: "order_number",
      header: "Order",
      render: (o) => (
        <div>
          <Link href={`/admin/orders/${o.id}`} className="font-medium text-emerald-800 hover:underline">{o.order_number}</Link>
          <p className="text-xs text-muted-foreground">{formatDateTime(o.created_at)}</p>
        </div>
      ),
    },
    { key: "customer_name", header: "Customer" },
    { key: "city", header: "Destination", hideInCard: true },
    { key: "cod_amount", header: "COD", render: (o) => formatCurrency(o.cod_amount) },
    { key: "status", header: "Status", render: (o) => <OrderStatusBadge status={o.status} /> },
    { key: "booking_status", header: "Booking", render: (o) => <BookingStatusBadge status={o.booking_status} /> },
    {
      key: "booking_error",
      header: "Last error",
      render: (o) => (o.booking_error ? <span className="text-xs text-rose-600">{o.booking_error}</span> : "—"),
      hideInCard: true,
    },
    {
      key: "actions",
      header: "",
      render: (o) => (
        <Button size="sm" disabled={busyId === o.id || o.booking_status === "booked"} onClick={() => void book(o)}>
          {busyId === o.id ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : o.booking_status === "failed" ? <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}
          {o.booking_status === "failed" ? "Retry" : "Book"}
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Flaship Booking"
        description="Book unbooked orders with Flaship — duplicate bookings are blocked server-side"
        actions={
          <Button variant="outline" onClick={refresh} disabled={loading}>
            <RefreshCw className={loading ? "mr-1.5 h-4 w-4 animate-spin" : "mr-1.5 h-4 w-4"} /> Refresh
          </Button>
        }
      />

      <Alert className="border-sky-200 bg-sky-50/60">
        <Info className="h-4 w-4 text-sky-600" />
        <AlertDescription className="text-sky-800">
          Mode: <strong>{cfg?.mode === "live" ? "Live API" : "Simulator (demo)"}</strong>. API calls run server-side only —
          the Flaship API key is never exposed to the browser. Configure it via{" "}
          <code className="rounded bg-sky-100 px-1">FLASHIP_API_KEY</code> and the endpoints in Settings → Flaship API.
        </AlertDescription>
      </Alert>

      {/* Booking defaults (courier / service / pickup) */}
      <Card className="py-3">
        <CardContent className="grid gap-3 px-3 sm:grid-cols-3">
          <div>
            <Label className="mb-1 block text-xs text-muted-foreground">Courier</Label>
            <select value={courier} onChange={(e) => setCourier(e.target.value)} className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm">
              <option value="">Default (from settings)</option>
              {(catalog?.couriers ?? []).map((c) => (
                <option key={c.id} value={c.courier_id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <Label className="mb-1 block text-xs text-muted-foreground">Service type</Label>
            <select value={serviceType} onChange={(e) => setServiceType(e.target.value)} className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm">
              <option value="overnight">Overnight</option>
              <option value="overland">Overland</option>
              <option value="detain">Detain</option>
            </select>
          </div>
          <div>
            <Label className="mb-1 block text-xs text-muted-foreground">Pickup location</Label>
            <select value={pickup} onChange={(e) => setPickup(e.target.value)} className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm">
              <option value="">Default (from settings)</option>
              {(catalog?.pickups ?? []).map((p) => (
                <option key={p.id} value={p.pickup_id}>{p.name}{p.address ? ` — ${p.address}` : ""}</option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      {message ? (
        <div
          className={message.kind === "ok"
            ? "rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
            : "rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"}
          role="status"
        >
          {message.text}
        </div>
      ) : null}

      {loading && !data ? (
        <PageSpinner />
      ) : error ? (
        <ErrorState message={error} onRetry={refresh} />
      ) : (
        <DataTable
          columns={columns}
          rows={data?.rows}
          loading={loading}
          error={null}
          emptyTitle={bookable.length === 0 && (data?.total ?? 0) > 0 ? "All caught up" : "No orders to book"}
          emptyDescription={bookable.length === 0 && (data?.total ?? 0) > 0 ? "Every order here is booked." : "Orders appear here once created (CREATED / PENDING / ASSIGNED)."}
          emptyIcon={BookOpen}
          page={page}
          perPage={15}
          total={data?.total ?? 0}
          onPageChange={setPage}
        />
      )}
    </div>
  );
}
