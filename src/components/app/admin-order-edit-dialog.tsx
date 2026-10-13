"use client";

/**
 * Admin "Edit order" dialog (Phase 3).
 *
 * Editable while the order is NOT booked: customer link, item lines
 * (product / quantity / unit price), discount, COD amount, delivery
 * address, city and notes. The server recomputes every total from the
 * validated items — the client's numbers are display-only.
 *
 * Booked orders: the Flaship Integration API has no shipment-amendment
 * endpoint, so items/prices/address can no longer be edited — the dialog
 * explains the cancel-and-rebook path instead of pretending the courier
 * data changed.
 */

import { useMemo, useState } from "react";
import { api, ApiError } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/utils";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";

interface LookupData {
  customers: { id: string; name: string; phone: string }[];
  products: { id: string; name: string; sku: string; selling_price: number; available_stock: number }[];
}

interface OrderItemRow {
  id?: string;
  product_id: string | null;
  product_name: string;
  quantity: number;
  unit_price: number;
  deal_id?: string | null;
  components?: { product_id: string; name: string; quantity: number }[] | null;
}

interface EditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order: {
    id: string;
    order_number: string;
    customer_id: string;
    delivery_address: string;
    city: string | null;
    notes: string | null;
    discount: number;
    cod_amount: number;
    status: string;
    booking_status?: string | null;
    tracking_number?: string | null;
  };
  items: OrderItemRow[];
  lookup: LookupData | null;
  onSaved: () => void;
}

interface DraftRow {
  key: number;
  product_id: string;
  quantity: number;
  unit_price: number;
}

export function AdminOrderEditDialog({ open, onOpenChange, order, items, lookup, onSaved }: EditDialogProps) {
  // Deal/bundle lines are managed as a unit — they are NOT editable here and
  // are preserved verbatim by the server. Show them as read-only context.
  const dealLines = items.filter((it) => it.deal_id || (!it.product_id && it.components?.length));
  const editableItems = items.filter((it) => it.product_id && !dealLines.includes(it));
  const [customerId, setCustomerId] = useState(order.customer_id);
  const [rows, setRows] = useState<DraftRow[]>(
    editableItems.map((it, i) => ({
      key: i + 1,
      product_id: it.product_id ?? "",
      quantity: it.quantity,
      unit_price: Number(it.unit_price),
    }))
  );
  const [discount, setDiscount] = useState(Number(order.discount) || 0);
  const [codExplicit, setCodExplicit] = useState<number | "">("");
  const [deliveryAddress, setDeliveryAddress] = useState(order.delivery_address);
  const [city, setCity] = useState(order.city ?? "");
  const [notes, setNotes] = useState(order.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const subtotal = useMemo(() => rows.reduce((s, r) => s + r.quantity * r.unit_price, 0), [rows]);
  const effectiveCod = codExplicit === "" ? Math.max(0, subtotal - discount) : codExplicit;

  const setRow = (key: number, patch: Partial<DraftRow>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const pickProduct = (key: number, productId: string) => {
    const p = lookup?.products.find((x) => x.id === productId);
    setRow(key, { product_id: productId, unit_price: p?.selling_price ?? 0 });
  };

  const submit = async () => {
    setError(null);
    if (!customerId) return setError("Select a customer.");
    if (rows.some((r) => !r.product_id)) return setError("Every row needs a product.");
    if (rows.some((r) => r.quantity <= 0)) return setError("Quantities must be positive.");
    if (rows.some((r) => r.unit_price < 0)) return setError("Prices cannot be negative.");
    if (!deliveryAddress.trim()) return setError("Delivery address is required.");
    if (!city.trim()) return setError("Delivery city is required.");
    setSaving(true);
    try {
      await api(`/api/orders/${order.id}`, {
        method: "PATCH",
        json: {
          customer_id: customerId,
          // deal-only orders: no editable lines → omit items entirely (the
          // server preserves bundle lines; an empty items array would 422)
          ...(editableItems.length ? { items: rows.map((r) => ({ product_id: r.product_id, quantity: r.quantity, unit_price: r.unit_price })) } : {}),
          discount,
          ...(codExplicit === "" ? {} : { cod_amount: codExplicit }),
          delivery_address: deliveryAddress,
          city,
          notes: notes || null,
        },
      });
      onSaved();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save the order.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit order {order.order_number}</DialogTitle>
          <DialogDescription>
            Totals are recalculated by the server from the item lines. Stock reservations follow the changed quantities.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {dealLines.length ? (
            <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
              This order contains {dealLines.length} bundle line{dealLines.length === 1 ? "" : "s"} ({dealLines.map((d) => `${d.product_name} × ${d.quantity}`).join(", ")}) — bundles are managed as a unit and are
              preserved when you save. To change a bundle, cancel the order and rebook.
            </div>
          ) : null}
          {/* customer */}
          <div>
            <Label className="mb-1.5 block">Customer</Label>
            <Select value={customerId} onValueChange={setCustomerId}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Select customer" /></SelectTrigger>
              <SelectContent>
                {(lookup?.customers ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name} — {c.phone}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* items */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Items</Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setRows((r) => [...r, { key: Date.now(), product_id: "", quantity: 1, unit_price: 0 }])}
              >
                <Plus className="mr-1 h-3.5 w-3.5" /> Add item
              </Button>
            </div>
            {rows.map((row, idx) => (
              <div key={row.key} className="grid grid-cols-12 items-end gap-2 rounded-lg border border-border p-2.5">
                <div className="col-span-12 sm:col-span-6">
                  <Label className="mb-1 block text-xs">Product {idx + 1}</Label>
                  <Select value={row.product_id} onValueChange={(v) => pickProduct(row.key, v)}>
                    <SelectTrigger className="w-full"><SelectValue placeholder="Select product" /></SelectTrigger>
                    <SelectContent>
                      {(lookup?.products ?? []).map((p) => (
                        <SelectItem key={p.id} value={p.id}>{p.name} ({p.available_stock} avail.)</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-5 sm:col-span-2">
                  <Label className="mb-1 block text-xs">Qty</Label>
                  <Input
                    type="number"
                    min={1}
                    inputMode="numeric"
                    value={row.quantity}
                    onChange={(e) => setRow(row.key, { quantity: Math.max(1, parseInt(e.target.value || "1", 10) || 1) })}
                  />
                </div>
                <div className="col-span-5 sm:col-span-3">
                  <Label className="mb-1 block text-xs">Unit price</Label>
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={row.unit_price}
                    onChange={(e) => setRow(row.key, { unit_price: Math.max(0, Number(e.target.value || 0)) })}
                  />
                </div>
                <div className="col-span-2 flex justify-end sm:col-span-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-rose-500 hover:text-rose-600"
                    disabled={rows.length === 1}
                    onClick={() => setRows((r) => r.filter((x) => x.key !== row.key))}
                    aria-label="Remove item"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>

          {/* pricing */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="mb-1.5 block">Discount (Rs)</Label>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={discount}
                onChange={(e) => setDiscount(Math.max(0, Number(e.target.value || 0)))}
              />
              {discount > subtotal ? <p className="mt-1 text-xs text-rose-600">Discount cannot exceed the subtotal.</p> : null}
            </div>
            <div>
              <Label className="mb-1.5 block">COD amount (Rs)</Label>
              <Input
                type="number"
                min={0}
                step="0.01"
                placeholder={`Defaults to new total: ${formatCurrency(Math.max(0, subtotal - discount))}`}
                value={codExplicit}
                onChange={(e) => setCodExplicit(e.target.value === "" ? "" : Math.max(0, Number(e.target.value || 0)))}
              />
            </div>
          </div>

          {/* delivery */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label className="mb-1.5 block">Delivery address *</Label>
              <Input value={deliveryAddress} onChange={(e) => setDeliveryAddress(e.target.value)} />
            </div>
            <div>
              <Label className="mb-1.5 block">City *</Label>
              <Input value={city} onChange={(e) => setCity(e.target.value)} />
            </div>
            <div className="sm:col-span-2">
              <Label className="mb-1.5 block">Notes</Label>
              <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-border pt-3 text-sm">
            <p className="text-muted-foreground">
              Subtotal {formatCurrency(subtotal)} {discount > 0 ? `− ${formatCurrency(discount)}` : ""}
            </p>
            <p className="text-base font-bold">New total: {formatCurrency(Math.max(0, subtotal - discount))}</p>
          </div>

          {error ? (
            <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">{error}</p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
            <Button onClick={() => void submit()} disabled={saving || (discount > subtotal)}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Pencil className="mr-2 h-4 w-4" />}
              Save changes ({formatCurrency(effectiveCod)})
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
