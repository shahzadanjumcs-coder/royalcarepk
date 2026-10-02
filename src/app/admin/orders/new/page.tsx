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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { formatCurrency, todayISO } from "@/lib/utils";
import { Loader2, Plus, Trash2, AlertTriangle, Save } from "lucide-react";

interface LookupData {
  customers: { id: string; name: string; phone: string; city: string | null; address: string | null }[];
  products: { id: string; name: string; sku: string; selling_price: number; available_stock: number }[];
  workers: { id: string; name: string; commission_rate: number }[];
  flaship: { mode: string; default_courier: string | null; default_pickup: string | null };
}

interface ItemRow {
  key: number;
  product_id: string;
  quantity: number;
  unit_price: number;
}

export default function NewOrderPage() {
  const router = useRouter();
  const { data: lookup, loading, error, refresh } = useApi<LookupData>("/api/lookup");
  const [customerMode, setCustomerMode] = useState<"existing" | "new">("existing");
  const [customerId, setCustomerId] = useState("");
  const [newCustomer, setNewCustomer] = useState({ name: "", phone: "", email: "", address: "", city: "" });
  const [items, setItems] = useState<ItemRow[]>([{ key: 1, product_id: "", quantity: 1, unit_price: 0 }]);
  const [discount, setDiscount] = useState(0);
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [city, setCity] = useState("");
  const [notes, setNotes] = useState("");
  const [workerId, setWorkerId] = useState("none");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const subtotal = useMemo(
    () => items.reduce((s, i) => s + i.quantity * i.unit_price, 0),
    [items]
  );
  const total = Math.max(0, subtotal - discount);

  const setItem = (key: number, patch: Partial<ItemRow>) =>
    setItems((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const pickProduct = (key: number, productId: string) => {
    const p = lookup?.products.find((x) => x.id === productId);
    setItem(key, { product_id: productId, unit_price: p?.selling_price ?? 0 });
  };

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (customerMode === "existing" && !customerId) errs.customer = "Select a customer.";
    if (customerMode === "new") {
      if (!newCustomer.name.trim()) errs.customer = "Customer name is required.";
      if (!/^[0-9+\-\s()]{7,20}$/.test(newCustomer.phone)) errs.customer = "A valid customer phone is required.";
    }
    if (items.some((i) => !i.product_id)) errs.items = "Every row needs a product.";
    if (items.some((i) => i.quantity <= 0)) errs.items = "Quantities must be positive.";
    if (items.some((i) => i.unit_price < 0)) errs.items = "Prices cannot be negative.";
    if (discount < 0 || discount > subtotal) errs.discount = "Discount must be between 0 and the subtotal.";
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
      const res = await api<{ order: { id: string } }>("/api/orders", {
        method: "POST",
        json: {
          customer:
            customerMode === "existing"
              ? { id: customerId }
              : { name: newCustomer.name, phone: newCustomer.phone, email: newCustomer.email, address: newCustomer.address, city: newCustomer.city },
          items: items.map((i) => ({ product_id: i.product_id, quantity: i.quantity, unit_price: i.unit_price })),
          discount,
          delivery_address: deliveryAddress,
          city,
          notes: notes || null,
          worker_id: workerId !== "none" ? workerId : null,
        },
      });
      router.push(`/admin/orders/${res.order.id}`);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : "Could not create the order.");
      setSubmitting(false);
    }
  };

  if (loading) return <PageSpinner />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  return (
    <form onSubmit={submit} className="mx-auto max-w-4xl space-y-5" noValidate>
      <PageHeader title="Create Order" description="Customer, items, COD and assignment — stock is reserved on save" />

      {lookup?.flaship.mode !== "live" ? (
        <Alert className="border-sky-200 bg-sky-50/60">
          <AlertTriangle className="h-4 w-4 text-sky-600" />
          <AlertDescription className="text-sky-800">
            Flaship is running in <strong>simulator</strong> mode. Bookings will generate demo CN numbers until you
            configure <code className="rounded bg-sky-100 px-1">FLASHIP_API_KEY</code>.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Customer */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Customer</CardTitle>
        </CardHeader>
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
                <SelectTrigger className="w-full"><SelectValue placeholder="Search by name…" /></SelectTrigger>
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
              <div>
                <Label className="mb-1.5 block">Email</Label>
                <Input type="email" value={newCustomer.email} onChange={(e) => setNewCustomer({ ...newCustomer, email: e.target.value })} placeholder="Optional" />
              </div>
              <div>
                <Label className="mb-1.5 block">City</Label>
                <Input value={newCustomer.city} onChange={(e) => setNewCustomer({ ...newCustomer, city: e.target.value })} placeholder="Karachi" />
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
          <Button type="button" size="sm" variant="outline" onClick={() => setItems((r) => [...r, { key: Date.now(), product_id: "", quantity: 1, unit_price: 0 }])}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add item
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {items.map((row, idx) => {
            const product = lookup?.products.find((p) => p.id === row.product_id);
            return (
              <div key={row.key} className="grid grid-cols-12 items-end gap-2 rounded-lg border border-border p-3">
                <div className="col-span-12 sm:col-span-5">
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
                <div className="col-span-4 sm:col-span-2">
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
                  <Input
                    type="number"
                    min={0}
                    inputMode="decimal"
                    value={row.unit_price}
                    onChange={(e) => setItem(row.key, { unit_price: Math.max(0, Number(e.target.value || 0)) })}
                  />
                </div>
                <div className="col-span-2 sm:col-span-2 flex justify-end">
                  <span className="hidden text-sm font-medium sm:block">{formatCurrency(row.quantity * row.unit_price)}</span>
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
                    Only {product.available_stock} available — creation will fail unless stock is increased.
                  </p>
                ) : null}
              </div>
            );
          })}
          {fieldErrors.items ? <p className="text-xs text-rose-600">{fieldErrors.items}</p> : null}

          <div className="flex items-center justify-between border-t border-border pt-3 text-sm">
            <div className="flex items-center gap-2">
              <Label className="m-0">Discount (Rs)</Label>
              <Input
                type="number"
                min={0}
                className="h-8 w-28"
                value={discount}
                onChange={(e) => setDiscount(Math.max(0, Number(e.target.value || 0)))}
              />
            </div>
            <div className="text-right">
              <p className="text-muted-foreground">
                Subtotal {formatCurrency(subtotal)} {discount > 0 ? `− ${formatCurrency(discount)}` : ""}
              </p>
              <p className="text-base font-bold">COD total: {formatCurrency(total)}</p>
            </div>
          </div>
          {fieldErrors.discount ? <p className="text-xs text-rose-600">{fieldErrors.discount}</p> : null}
        </CardContent>
      </Card>

      {/* Shipping + worker */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Shipping &amp; Worker</CardTitle>
        </CardHeader>
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
          <div>
            <Label className="mb-1.5 block">Assign worker (optional)</Label>
            <Select value={workerId} onValueChange={setWorkerId}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Assign later</SelectItem>
                {(lookup?.workers ?? []).map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name} — {w.commission_rate}%
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-muted-foreground">
              The worker&apos;s commission rate is locked to this order at assignment.
            </p>
          </div>
          <div className="sm:col-span-2">
            <Label className="mb-1.5 block">Notes</Label>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional delivery instructions" />
          </div>
        </CardContent>
      </Card>

      {submitError ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{submitError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex items-center justify-end gap-2 pb-6">
        <Button type="button" variant="outline" onClick={() => router.back()} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
          Create order ({formatCurrency(total)})
        </Button>
      </div>
    </form>
  );
}
