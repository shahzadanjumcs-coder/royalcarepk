"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, useApi, ApiError } from "@/lib/client";
import { PageHeader, PageSpinner, ErrorState } from "@/components/app/states";
import { OrderStatusBadge, BookingStatusBadge, CommissionTypeBadge } from "@/components/app/badges";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import type { Order, OrderItem, OrderStatusHistory, Shipment, ShipmentTracking, CommissionTransaction, OrderStatus } from "@/lib/types";
import {
  ArrowLeft,
  BookOpen,
  CheckCheck,
  Loader2,
  MapPin,
  RefreshCw,
  Send,
  UserPlus,
  History as HistoryIcon,
  Wallet,
} from "lucide-react";

interface DetailData {
  order: Order & { customer_name: string; customer_phone: string; customer_email: string | null; worker_name: string | null };
  items: OrderItem[];
  history: OrderStatusHistory[];
  shipment: Shipment | null;
  tracking: ShipmentTracking[];
  commission: { net: number; transactions?: CommissionTransaction[] };
}

const NEXT_STATUS_OPTIONS: Record<string, { value: OrderStatus; label: string }[]> = {
  CREATED: [
    { value: "PENDING", label: "Mark Pending" },
    { value: "CANCELLED", label: "Cancel order" },
  ],
  PENDING: [{ value: "CANCELLED", label: "Cancel order" }],
  ASSIGNED: [
    { value: "PENDING", label: "Back to Pending" },
    { value: "CANCELLED", label: "Cancel order" },
  ],
  BOOKED: [
    { value: "IN_TRANSIT", label: "Mark In Transit" },
    { value: "RETURNED", label: "Mark Returned" },
    { value: "CANCELLED", label: "Cancel order" },
  ],
  IN_TRANSIT: [
    { value: "DELIVERED", label: "Mark Delivered" },
    { value: "RETURNED", label: "Mark Returned" },
  ],
  DELIVERED: [{ value: "RETURNED", label: "Mark Returned (RTO)" }],
  RETURNED: [],
  CANCELLED: [],
};

export default function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data, loading, error, refresh } = useApi<DetailData>(`/api/orders/${id}`);
  const { data: lookup } = useApi<{
    workers: { id: string; name: string; commission_rate: number }[];
    couriers: { id: string; courier_id: string; name: string }[];
    pickups: { id: string; pickup_id: string; name: string }[];
  }>("/api/lookup");

  const [statusNote, setStatusNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [courier, setCourier] = useState("");
  const [pickup, setPickup] = useState("");
  const [workerId, setWorkerId] = useState("");

  useEffect(() => {
    if (lookup && !courier) {
      setCourier(lookup.couriers[0]?.courier_id ?? "");
      setPickup(lookup.pickups[0]?.pickup_id ?? "");
    }
  }, [lookup, courier]);

  const run = useCallback(
    async (key: string, fn: () => Promise<string | void>) => {
      setBusy(key);
      setActionError(null);
      setActionSuccess(null);
      try {
        const msg = await fn();
        if (msg) setActionSuccess(msg);
        refresh();
      } catch (e) {
        setActionError(e instanceof ApiError ? e.message : "Action failed. Please try again.");
      } finally {
        setBusy(null);
      }
    },
    [refresh]
  );

  if (loading) return <PageSpinner />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;
  if (!data) return null;

  const { order, items, history, shipment, tracking, commission } = data;
  const nextOptions = NEXT_STATUS_OPTIONS[order.status] ?? [];

  const changeStatus = (status: OrderStatus) =>
    run(`status-${status}`, async () => {
      await api(`/api/orders/${id}/status`, { method: "POST", json: { status, note: statusNote || null } });
      setStatusNote("");
      return `Status changed to ${status.replace(/_/g, " ")}.`;
    });

  const book = () =>
    run("book", async () => {
      const res = await api<{ trackingNumber: string; courierName: string }>(`/api/orders/${id}/book`, {
        method: "POST",
        json: { courier: courier || undefined, pickup: pickup || undefined },
      });
      return `Booked with ${res.courierName} — CN ${res.trackingNumber}`;
    });

  const sync = () =>
    run("sync", async () => {
      const res = await api<{ message: string }>(`/api/orders/${id}/sync`, { method: "POST" });
      return res.message;
    });

  const assign = () =>
    run("assign", async () => {
      if (!workerId) return "Select a worker first.";
      await api(`/api/orders/${id}/assign`, { method: "POST", json: { worker_id: workerId } });
      return "Worker assigned.";
    });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => router.push("/admin/orders")}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Orders
        </Button>
      </div>

      <PageHeader
        title={order.order_number}
        description={`${order.customer_name} · ${order.city} · ${formatDateTime(order.created_at)}`}
        actions={<OrderStatusBadge status={order.status} className="text-xs" />}
      />

      {actionError ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
          {actionError}
        </div>
      ) : null}
      {actionSuccess ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800" role="status">
          {actionSuccess}
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-3">
        {/* LEFT column */}
        <div className="space-y-4 xl:col-span-2">
          {/* Status actions */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Workflow actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Booking */}
              <div className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <BookOpen className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Flaship booking</span>
                    <BookingStatusBadge status={order.booking_status} />
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" disabled={!order.tracking_number || busy === "sync"} onClick={sync}>
                      {busy === "sync" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
                      Sync tracking
                    </Button>
                    {order.booking_status === "failed" || !order.tracking_number ? (
                      <Button size="sm" disabled={busy === "book"} onClick={book}>
                        {busy === "book" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}
                        {order.booking_status === "failed" ? "Retry booking" : "Book with Flaship"}
                      </Button>
                    ) : null}
                  </div>
                </div>
                {order.booking_error ? (
                  <p className="mt-2 rounded-md bg-rose-50 px-2.5 py-1.5 text-xs text-rose-700">{order.booking_error}</p>
                ) : null}
                {!order.tracking_number ? (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <div>
                      <Label className="mb-1 block text-xs">Courier</Label>
                      <Select value={courier} onValueChange={setCourier}>
                        <SelectTrigger className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {(lookup?.couriers ?? []).map((c) => (
                            <SelectItem key={c.id} value={c.courier_id}>{c.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="mb-1 block text-xs">Pickup location</Label>
                      <Select value={pickup} onValueChange={setPickup}>
                        <SelectTrigger className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {(lookup?.pickups ?? []).map((p) => (
                            <SelectItem key={p.id} value={p.pickup_id}>{p.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                ) : (
                  <div className="mt-2 grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-3">
                    <p><span className="font-medium text-foreground">CN:</span> {order.tracking_number}</p>
                    <p><span className="font-medium text-foreground">Courier:</span> {order.flaship_courier_name ?? "—"}</p>
                    <p><span className="font-medium text-foreground">Booked:</span> {formatDateTime(order.booked_at)}</p>
                    {order.pickup_location_name ? (
                      <p className="sm:col-span-3"><MapPin className="mr-1 inline h-3 w-3" />{order.pickup_location_name}</p>
                    ) : null}
                  </div>
                )}
              </div>

              {/* Status change */}
              {nextOptions.length > 0 ? (
                <div className="rounded-lg border border-border p-3">
                  <p className="mb-2 text-sm font-medium">Change status</p>
                  <div className="flex flex-wrap gap-2">
                    {nextOptions.map((o) => (
                      <Button
                        key={o.value}
                        size="sm"
                        variant={o.value === "CANCELLED" || o.value === "RETURNED" ? "outline" : "default"}
                        className={o.value === "CANCELLED" || o.value === "RETURNED" ? "border-rose-200 text-rose-700 hover:bg-rose-50" : ""}
                        disabled={busy?.startsWith("status-")}
                        onClick={() => changeStatus(o.value)}
                      >
                        {busy === `status-${o.value}` ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                        {o.label}
                      </Button>
                    ))}
                  </div>
                  <Input
                    className="mt-2"
                    placeholder="Optional note recorded with this status change…"
                    value={statusNote}
                    onChange={(e) => setStatusNote(e.target.value)}
                  />
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Delivered finalizes stock deduction + credits commission once. Returned restores stock and reverses
                    commission once.
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">This order is closed — no further status changes.</p>
              )}

              {/* Assign worker */}
              {!["DELIVERED", "RETURNED", "CANCELLED"].includes(order.status) ? (
                <div className="rounded-lg border border-border p-3">
                  <p className="mb-2 flex items-center gap-2 text-sm font-medium">
                    <UserPlus className="h-4 w-4 text-muted-foreground" /> Assign worker
                    {order.worker_name ? <span className="text-xs font-normal text-muted-foreground">(currently {order.worker_name})</span> : null}
                  </p>
                  <div className="flex gap-2">
                    <Select value={workerId} onValueChange={setWorkerId}>
                      <SelectTrigger className="h-9 w-full sm:w-64"><SelectValue placeholder="Select worker" /></SelectTrigger>
                      <SelectContent>
                        {(lookup?.workers ?? []).map((w) => (
                          <SelectItem key={w.id} value={w.id}>{w.name} — {w.commission_rate}%</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button size="sm" onClick={assign} disabled={busy === "assign" || !workerId}>
                      {busy === "assign" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                      Assign
                    </Button>
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Commission % snapshot is locked to this order the moment a worker is assigned.
                  </p>
                </div>
              ) : null}
            </CardContent>
          </Card>

          {/* Items */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Items ({items.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="divide-y divide-border/70">
                {items.map((it) => (
                  <div key={it.id} className="flex items-center justify-between py-2.5 text-sm">
                    <div>
                      <p className="font-medium">{it.product_name}</p>
                      <p className="text-xs text-muted-foreground">{it.sku} · {it.quantity} × {formatCurrency(it.unit_price)}</p>
                    </div>
                    <span className="font-semibold">{formatCurrency(it.line_total)}</span>
                  </div>
                ))}
              </div>
              <Separator className="my-3" />
              <div className="space-y-1 text-sm">
                <div className="flex justify-between text-muted-foreground"><span>Subtotal</span><span>{formatCurrency(order.subtotal)}</span></div>
                {order.discount > 0 ? (
                  <div className="flex justify-between text-muted-foreground"><span>Discount</span><span>− {formatCurrency(order.discount)}</span></div>
                ) : null}
                <div className="flex justify-between text-base font-bold"><span>COD amount</span><span>{formatCurrency(order.cod_amount)}</span></div>
              </div>
            </CardContent>
          </Card>

          {/* Tracking checkpoints */}
          {tracking.length > 0 ? (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base"><RefreshCw className="h-4 w-4 text-muted-foreground" /> Courier tracking</CardTitle>
              </CardHeader>
              <CardContent>
                <ol className="space-y-3">
                  {tracking.map((t) => (
                    <li key={t.id} className="flex gap-3">
                      <span className="mt-1 flex h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
                      <div>
                        <p className="text-sm font-medium">{t.status.replace(/_/g, " ")}</p>
                        <p className="text-xs text-muted-foreground">{t.description} {t.location ? `· ${t.location}` : ""}</p>
                        <p className="text-[11px] text-muted-foreground/70">{formatDateTime(t.scanned_at)}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          ) : null}
        </div>

        {/* RIGHT column */}
        <div className="space-y-4">
          {/* Commission */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base"><Wallet className="h-4 w-4 text-muted-foreground" /> Commission</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Worker</span><span className="font-medium">{order.worker_name ?? "Unassigned"}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Rate (locked)</span><span className="font-medium">{order.commission_rate !== null ? `${order.commission_rate}%` : "—"}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Net ledger effect</span><span className="font-semibold">{formatCurrency(commission.net)}</span></div>
              {commission.transactions && commission.transactions.length > 0 ? (
                <div className="mt-2 space-y-1.5 border-t border-border pt-2">
                  {commission.transactions.map((t) => (
                    <div key={t.id} className="flex items-center justify-between gap-2">
                      <CommissionTypeBadge type={t.type} />
                      <span className={t.amount >= 0 ? "font-semibold text-emerald-700" : "font-semibold text-rose-600"}>
                        {formatCurrency(t.amount)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No ledger entries yet.</p>
              )}
            </CardContent>
          </Card>

          {/* Delivery info */}
          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-base">Delivery</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="font-medium">{order.customer_name}</p>
              <p className="text-muted-foreground">{order.customer_phone}{order.customer_email ? ` · ${order.customer_email}` : ""}</p>
              <p className="text-muted-foreground">{order.delivery_address}, {order.city}</p>
              {order.notes ? <p className="rounded-md bg-muted px-2.5 py-1.5 text-xs">{order.notes}</p> : null}
            </CardContent>
          </Card>

          {/* Status history */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base"><HistoryIcon className="h-4 w-4 text-muted-foreground" /> Status history</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="relative space-y-4 border-l border-border pl-4">
                {history.map((h) => (
                  <li key={h.id}>
                    <span className="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-500" />
                    <div className="flex items-center gap-2">
                      <OrderStatusBadge status={h.status} className="text-[11px]" />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{h.note ?? "—"}</p>
                    <p className="text-[11px] text-muted-foreground/70">{formatDateTime(h.created_at)} · {h.created_by_name ?? "system"}</p>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
