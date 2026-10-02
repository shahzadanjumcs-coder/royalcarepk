"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { api, useApi, ApiError } from "@/lib/client";
import { PageHeader, PageSpinner, ErrorState } from "@/components/app/states";
import { OrderStatusBadge } from "@/components/app/badges";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import type { Order, OrderItem, OrderStatusHistory, Shipment, ShipmentTracking } from "@/lib/types";
import { ArrowLeft, CheckCircle2, Loader2, RotateCcw, Truck, MapPin, Phone } from "lucide-react";
import { cn } from "@/lib/utils";

interface DetailData {
  order: Order & { customer_name: string; customer_phone: string };
  items: OrderItem[];
  history: OrderStatusHistory[];
  shipment: Shipment | null;
  tracking: ShipmentTracking[];
  commission: { net: number };
}

export default function WorkerOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data, loading, error, refresh } = useApi<DetailData>(`/api/orders/${id}`);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (loading) return <PageSpinner />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;
  if (!data) return null;
  const { order, items, history } = data;

  const changeStatus = async (status: string, label: string) => {
    setBusy(status);
    setErr(null);
    setMsg(null);
    try {
      await api(`/api/orders/${id}/status`, { method: "POST", json: { status, note: note || null } });
      setMsg(`Order marked as ${label}.`);
      setNote("");
      refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Update failed.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Button variant="ghost" size="sm" onClick={() => router.push("/worker/orders")}>
        <ArrowLeft className="mr-1 h-4 w-4" /> My Orders
      </Button>

      <PageHeader
        title={order.order_number}
        description={formatDateTime(order.created_at)}
        actions={<OrderStatusBadge status={order.status} />}
      />

      {msg ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{msg}</div> : null}
      {err ? <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div> : null}

      {/* Customer card — call button for mobile riders */}
      <Card>
        <CardContent className="flex items-start justify-between gap-3 p-4">
          <div>
            <p className="font-medium">{order.customer_name}</p>
            <p className="mt-0.5 text-sm text-muted-foreground">{order.delivery_address}</p>
            <p className="text-sm text-muted-foreground">{order.city}</p>
            {order.notes ? <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">📌 {order.notes}</p> : null}
          </div>
          <a
            href={`tel:${order.customer_phone}`}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white"
            aria-label={`Call ${order.customer_name}`}
          >
            <Phone className="h-5 w-5" />
          </a>
        </CardContent>
      </Card>

      {/* Status actions (only transitions workers are allowed to make) */}
      {["BOOKED", "IN_TRANSIT"].includes(order.status) ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Update delivery status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {order.status === "BOOKED" ? (
                <Button className="h-12" disabled={busy !== null} onClick={() => changeStatus("IN_TRANSIT", "in transit")}>
                  {busy === "IN_TRANSIT" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Truck className="mr-2 h-4 w-4" />}
                  Picked up / In transit
                </Button>
              ) : null}
              {order.status === "IN_TRANSIT" ? (
                <>
                  <Button className="h-12 bg-emerald-600 hover:bg-emerald-700" disabled={busy !== null} onClick={() => changeStatus("DELIVERED", "delivered")}>
                    {busy === "DELIVERED" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                    Delivered (COD {formatCurrency(order.cod_amount)})
                  </Button>
                  <Button variant="outline" className="h-12 border-rose-200 text-rose-700 hover:bg-rose-50" disabled={busy !== null} onClick={() => changeStatus("RETURNED", "returned")}>
                    {busy === "RETURNED" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}
                    Customer refused
                  </Button>
                </>
              ) : null}
            </div>
            <Input placeholder="Optional note (e.g. customer unavailable)…" value={note} onChange={(e) => setNote(e.target.value)} />
            <p className="text-xs text-muted-foreground">
              Marking delivered credits your commission once ({order.commission_rate ?? 0}% of COD). Returned reverses it once.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {/* Items */}
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Parcel items</CardTitle></CardHeader>
        <CardContent className="divide-y divide-border/70">
          {items.map((it) => (
            <div key={it.id} className="flex justify-between py-2.5 text-sm">
              <div>
                <p className="font-medium">{it.product_name}</p>
                <p className="text-xs text-muted-foreground">{it.quantity} × {formatCurrency(it.unit_price)}</p>
              </div>
              <span className="font-semibold">{formatCurrency(it.line_total)}</span>
            </div>
          ))}
          <div className="flex justify-between pt-3 text-base font-bold">
            <span>COD to collect</span>
            <span>{formatCurrency(order.cod_amount)}</span>
          </div>
        </CardContent>
      </Card>

      {/* My commission */}
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">My commission on this order</CardTitle></CardHeader>
        <CardContent className="text-sm">
          <p>
            Rate locked: <strong>{order.commission_rate ?? 0}%</strong> · potential:{" "}
            <strong>{formatCurrency(Math.round((order.cod_amount * (order.commission_rate ?? 0)) / 100))}</strong>
          </p>
          <p className="mt-1 text-muted-foreground">Ledger effect so far: <strong>{formatCurrency(data.commission.net)}</strong></p>
        </CardContent>
      </Card>

      {/* History */}
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Timeline</CardTitle></CardHeader>
        <CardContent>
          <ol className="relative space-y-4 border-l border-border pl-4">
            {history.map((h) => (
              <li key={h.id}>
                <span className={cn("absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full border-2 border-white", h.status === "DELIVERED" ? "bg-emerald-500" : h.status === "RETURNED" ? "bg-rose-500" : "bg-slate-400")} />
                <OrderStatusBadge status={h.status} className="text-[11px]" />
                <p className="mt-1 text-xs text-muted-foreground">{h.note ?? "—"}</p>
                <p className="text-[11px] text-muted-foreground/70">{formatDateTime(h.created_at)}</p>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
