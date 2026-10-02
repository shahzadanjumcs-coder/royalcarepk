"use client";

import { useState } from "react";
import { useApi, api, ApiError } from "@/lib/client";
import { PageHeader, PageSpinner, ErrorState } from "@/components/app/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Save } from "lucide-react";
import type { MovementType } from "@/lib/types";

export function StockMovementForm({
  title,
  description,
  type,
  quantityLabel,
  quantitySign,
  quantityFixedPositive = true,
}: {
  title: string;
  description: string;
  type: MovementType;
  quantityLabel: string;
  quantitySign?: -1 | 1;
  quantityFixedPositive?: boolean;
}) {
  const { data, loading, error, refresh } = useApi<{ rows: { id: string; name: string; sku: string; current_stock: number; reserved_stock: number }[] }>(
    "/api/inventory?perPage=100"
  );
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  if (loading) return <PageSpinner />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  const product = (data?.rows ?? []).find((p) => p.id === productId);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    setSuccess(null);
    if (!productId) return setSubmitError("Select a product.");
    if (!quantityFixedPositive && quantity === 0) return setSubmitError("Quantity cannot be zero.");
    const qty = quantitySign === -1 ? -Math.abs(quantity) : Math.abs(quantity);
    setSubmitting(true);
    try {
      await api("/api/inventory/movement", { method: "POST", json: { product_id: productId, type, quantity: qty, note: note || null } });
      setSuccess(`Stock updated: ${product?.name ?? "product"} ${qty > 0 ? "+" : ""}${qty}.`);
      setQuantity(1);
      setNote("");
      refresh();
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : "Could not record the movement.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <PageHeader title={title} description={description} />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Movement details</CardTitle>
          <CardDescription>Every movement is written to the stock ledger with your user and timestamp.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4" noValidate>
            <div>
              <Label className="mb-1.5 block">Product *</Label>
              <Select value={productId} onValueChange={setProductId}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Select product" /></SelectTrigger>
                <SelectContent>
                  {(data?.rows ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} ({p.sku}) — {p.current_stock - p.reserved_stock} avail.
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label className="mb-1.5 block">{quantityLabel} *</Label>
              <Input
                type="number"
                min={quantityFixedPositive ? 1 : undefined}
                value={quantity}
                onChange={(e) => setQuantity(Number(e.target.value ?? 0))}
                inputMode="numeric"
              />
            </div>

            <div>
              <Label className="mb-1.5 block">Note</Label>
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Supplier invoice, reason, etc." />
            </div>

            {product ? (
              <div className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                Current on hand: <strong className="text-foreground">{product.current_stock}</strong> · Reserved:{" "}
                <strong className="text-foreground">{product.reserved_stock}</strong> · Available:{" "}
                <strong className="text-foreground">{product.current_stock - product.reserved_stock}</strong>
              </div>
            ) : null}

            {submitError ? (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
                {submitError}
              </div>
            ) : null}
            {success ? (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800" role="status">
                {success}
              </div>
            ) : null}

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Record {type.replace(/_/g, " ").toLowerCase()}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
