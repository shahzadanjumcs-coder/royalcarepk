"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi, api, ApiError } from "@/lib/client";
import { PageHeader, PageSpinner, ErrorState } from "@/components/app/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatCurrency } from "@/lib/utils";
import { CheckCircle2, Loader2, Plus, Send, Trash2, Clock } from "lucide-react";

interface LookupData {
  customers: { id: string; name: string; phone: string; city: string | null; address: string | null }[];
  products: { id: string; name: string; sku: string; selling_price: number; available_stock: number }[];
}

interface ItemRow {
  key: number;
  product_id: string;
  quantity: number;
}

/**
 * Worker order submission. The order is created with approval_status = PENDING
 * (server-enforced: the session decides the worker, Flaship is never called).
 * It appears in "My Orders" as "Pending Admin Approval" until an admin
 * approves it.
 */
export default function WorkerNewOrderPage() {
  const router = useRouter();
  const { data: lookup, loading, error, refresh } = useApi<LookupData>("/api/lookup");
  const [customerMode, setCustomerMode] = useState<"existing" | "new">("existing");
  const [customerId, setCustomerId] = useState("");
  const [newCustomer, setNewCustomer] = useState({ name: "", phone: "", city: "" });
  const [items, setItems] = useState<ItemRow[]>([{ key: 1, product_id: "", quantity: 1 }]);
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [city, setCity] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submittedOrder, setSubmittedOrder] = useState<{ id: string; order_number: string } | null>(null);

  const total = useMemo(
    () => items.reduce((s, i) => {
      const p = lookup?.products.find((x) => x.id === i.product_id);
      return s + (p ? p.selling_price * i.quantity : 0);
    }, 0),
    [items, lookup]
  );

  const setItem = (key: number, patch: Partial<ItemRow>) =>
    setItems((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const pickProduct = (key: number, productId: string) => setItem(key, { product_id: productId });

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (customerMode === "existing" && !customerId) errs.customer = "Select a customer.";
    if (customerMode === "new") {
      if (!newCustomer.name.trim()) errs.customer = "Customer name is required.";
      if (!/^[0-9+\-\s()]{7,20}$/.test(newCustomer.phone)) errs.customer = "A valid customer phone is required.";
    }
    if (items.some((i) => !i.product_id)) errs.items = "Every row needs a product.";
    if (items.some((i) => i.quantity <= 0)) errs.items = "Quantities must be positive.";
    if (!deliveryAddress.trim()) errs.deliveryAddress = "Delivery address is required.";
    if (!city.trim()) errs.city = "Delivery city is required.";
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await api<{ order: { id: string; order_number: string } }>("/api/orders", {
        method: "POST",
        json: {
          customer:
            customerMode === "existing"
              ? { id: customerId }
              : { name: newCustomer.name, phone: newCustomer.phone, city: newCustomer.city },
          items: items.map((i) => ({ product_id: i.product_id, quantity: i.quantity, unit_price: 0 })),
          discount: 0,
          delivery_address: deliveryAddress,
          city,
          notes: notes || null,
        },
      });
      setSubmittedOrder(res.order);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : "Could not submit the order.");
    } finally {
      setSubmitting(false);
    }
  };

  if (submittedOrder) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <PageHeader title="Submit Order" description="New customer order for admin approval" />
        <Card className="border-emerald-200 bg-emerald-50/60">
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <CheckCircle2 className="h-12 w-12 text-emerald-600" />
            <p className="text-lg font-semibold text-emerald-800">Order {submittedOrder.order_number} submitted</p>
            <p className="flex items-center gap-1.5 text-sm font-medium text-amber-700">
              <Clock className="h-4 w-4" /> Pending Admin Approval
            </p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Your order was sent to the admin team. It will be booked with the courier only after an admin approves it.
              You can follow its status under My Orders.
            </p>
            <div className="mt-2 flex gap-2">
              <Button onClick={() => router.push("/worker/orders")}>View My Orders</Button>
              <Button
                variant="outline"
                onClick={() => {
                  setSubmittedOrder(null);
                  setItems([{ key: Date.now(), product_id: "", quantity: 1 }]);
                  setCustomerId("");
                  setCustomerMode("existing");
                  setNewCustomer({ name: "", phone: "", city: "" });
                  setDeliveryAddress("");
                  setCity("");
                  setNotes("");
                }}
              >
                Submit another
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loading) return <PageSpinner />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  return (
    <form onSubmit={submit} className="mx-auto max-w-3xl space-y-5" noValidate>
      <PageHeader title="Submit Order" description="New customer order — goes to the admin team for approval before courier booking" />

      {/* Customer */}
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Customer</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Button type="button" size="sm" variant={customerMode === "existing" ? "default" : "outline"} onClick={() => setCustomerMode("existing")}>
              Existing
            </Button>
            <Button type="button" size="sm" variant={customerMode === "new" ? "default" : "outline"} onClick={() => setCustomerMode("new")}>
              New customer
            </Button>
          </div>

          {customerMode === "existing" ? (
            <div>
              <Label className="mb-1.5 block">Select customer</Label>
              <Select
                value={customerId}
                onValueChange={(v) => {
                  setCustomerId(v);
                  const c = lookup?.customers.find((x) => x.id === v);
                  if (c) {
                    setDeliveryAddress((prev) => prev || c.address || "");
                    setCity((prev) => prev || c.city || "");
                  }
                }}
              >
                <SelectTrigger className="w-full"><SelectValue placeholder="Select by name…" /></SelectTrigger>
                <SelectContent>
                  {(lookup?.customers ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name} — {c.phone}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="mb-1.5 block">Name *</Label>
                <Input value={newCustomer.name} onChange={(e) => setNewCustomer({ ...newCustomer, name: e.target.value })} placeholder="Full name" />
              </div>
              <div>
                <Label className="mb-1.5 block">Phone *</Label>
                <Input value={newCustomer.phone} onChange={(e) => setNewCustomer({ ...newCustomer, phone: e.target.value })} placeholder="03001234567" inputMode="tel" />
              </div>
            </div>
          )}
          {fieldErrors.customer ? <p className="text-xs text-rose-600">{fieldErrors.customer}</p> : null}
        </CardContent>
      </Card>

      {/* Items */}
      <Card>
        <CardHeader className="flex-row items-center justify-between pb-3">
          <CardTitle className="text-base">Items</CardTitle>
          <Button type="button" size="sm" variant="outline" onClick={() => setItems((r) => [...r, { key: Date.now(), product_id: "", quantity: 1 }])}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add item
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {items.map((row, idx) => {
            const product = lookup?.products.find((p) => p.id === row.product_id);
            return (
              <div key={row.key} className="grid grid-cols-12 items-end gap-2 rounded-lg border border-border p-3">
                <div className="col-span-12 sm:col-span-6">
                  <Label className="mb-1 block text-xs">Product {idx + 1}</Label>
                  <Select value={row.product_id} onValueChange={(v) => pickProduct(row.key, v)}>
                    <SelectTrigger className="w-full"><SelectValue placeholder="Select product" /></SelectTrigger>
                    <SelectContent>
                      {(lookup?.products ?? []).map((p) => (
                        <SelectItem key={p.id} value={p.id} disabled={p.available_stock <= 0}>
                          {p.name} ({p.available_stock} avail.)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-6 sm:col-span-2">
                  <Label className="mb-1 block text-xs">Qty</Label>
                  <Input
                    type="number"
                    min={1}
                    inputMode="numeric"
                    value={row.quantity}
                    onChange={(e) => setItem(row.key, { quantity: Math.max(1, parseInt(e.target.value || "1", 10)) })}
                  />
                </div>
                <div className="col-span-5 sm:col-span-3">
                  <Label className="mb-1 block text-xs">Unit price</Label>
                  <Input value={product ? formatCurrency(product.selling_price) : "—"} disabled aria-readonly />
                </div>
                <div className="col-span-1 flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-rose-500 hover:text-rose-600"
                    disabled={items.length === 1}
                    onClick={() => setItems((r) => r.filter((x) => x.key !== row.key))}
                    aria-label="Remove item"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                {product && row.quantity > product.available_stock ? (
                  <p className="col-span-12 text-xs text-amber-600">
                    Only {product.available_stock} available — reduce the quantity or ask admin to restock.
                  </p>
                ) : null}
              </div>
            );
          })}
          {fieldErrors.items ? <p className="text-xs text-rose-600">{fieldErrors.items}</p> : null}

          <div className="flex items-center justify-between border-t border-border pt-3 text-sm">
            <p className="text-muted-foreground">Priced at the current catalogue price.</p>
            <p className="text-base font-bold">COD amount: {formatCurrency(total)}</p>
          </div>
        </CardContent>
      </Card>

      {/* Delivery */}
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Delivery</CardTitle></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label className="mb-1.5 block">Delivery address *</Label>
            <Input value={deliveryAddress} onChange={(e) => setDeliveryAddress(e.target.value)} placeholder="House, street, area" />
            {fieldErrors.deliveryAddress ? <p className="mt-1 text-xs text-rose-600">{fieldErrors.deliveryAddress}</p> : null}
          </div>
          <div>
            <Label className="mb-1.5 block">City *</Label>
            <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Karachi" />
            {fieldErrors.city ? <p className="mt-1 text-xs text-rose-600">{fieldErrors.city}</p> : null}
          </div>
          <div className="sm:col-span-2">
            <Label className="mb-1.5 block">Notes for the admin</Label>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional instructions (landmarks, delivery time…)" />
          </div>
        </CardContent>
      </Card>

      {submitError ? (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">{submitError}</p>
      ) : null}

      <div className="flex items-center justify-end gap-2 pb-6">
        <Button type="button" variant="outline" onClick={() => router.back()} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
          Submit for approval ({formatCurrency(total)})
        </Button>
      </div>
    </form>
  );
}
