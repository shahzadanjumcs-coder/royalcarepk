"use client";

/**
 * Deals & Bundles admin screen (Phase 5).
 *
 * A deal combines existing products into one bundle with a promotional
 * selling price. Orders snapshot the deal at order time; the inventory
 * lifecycle reserves/deducts/restores each component through the normal
 * order flow. Creating/editing is admin-only (the API enforces it too).
 */

import { useMemo, useState } from "react";
import { useApi, api, ApiError } from "@/lib/client";
import { useSession } from "@/lib/use-session";
import { PageHeader, PageSpinner, ErrorState } from "@/components/app/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { DataTable, type Column } from "@/components/app/data-table";
import { formatCurrency } from "@/lib/utils";
import { Loader2, Package, Pencil, Plus, Trash2 } from "lucide-react";

interface DealRow {
  id: string;
  name: string;
  description: string | null;
  selling_price: number;
  status: "active" | "inactive" | "archived";
  items: { id: string; product_id: string; product_name: string; sku: string; quantity: number; available_stock: number }[];
}

interface LookupData {
  products: { id: string; name: string; sku: string; selling_price: number; available_stock: number }[];
}

interface DraftComponent {
  key: number;
  product_id: string;
  quantity: number;
}

interface DealDraft {
  id?: string;
  name: string;
  description: string;
  selling_price: string;
  status: "active" | "inactive" | "archived";
  components: DraftComponent[];
}

const EMPTY_DRAFT: DealDraft = {
  name: "",
  description: "",
  selling_price: "",
  status: "active",
  components: [{ key: 1, product_id: "", quantity: 1 }],
};

export default function DealsPage() {
  const { session } = useSession();
  const isAdmin = session?.role === "super_admin" || session?.role === "admin";
  const { data, loading, error, refresh } = useApi<{ rows: DealRow[] }>("/api/deals");
  const { data: lookup } = useApi<LookupData>("/api/lookup");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<DealDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<DealRow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const deals = useMemo(() => data?.rows ?? [], [data]);
  const minBundleStock = (d: DealRow) =>
    d.items.length ? Math.min(...d.items.map((it) => Math.floor(it.available_stock / Math.max(1, it.quantity)))) : 0;

  const openCreate = () => {
    setDraft(EMPTY_DRAFT);
    setDialogError(null);
    setDialogOpen(true);
  };

  const openEdit = (d: DealRow) => {
    setDraft({
      id: d.id,
      name: d.name,
      description: d.description ?? "",
      selling_price: String(d.selling_price),
      status: d.status,
      components: d.items.map((it, i) => ({ key: i + 1, product_id: it.product_id, quantity: it.quantity })),
    });
    setDialogError(null);
    setDialogOpen(true);
  };

  const save = async () => {
    setDialogError(null);
    if (!draft.name.trim()) return setDialogError("Deal name is required.");
    const price = Number(draft.selling_price);
    if (!Number.isFinite(price) || price < 0) return setDialogError("Enter a valid selling price.");
    if (draft.components.some((c) => !c.product_id)) return setDialogError("Every component needs a product.");
    if (draft.components.some((c) => c.quantity <= 0)) return setDialogError("Component quantities must be positive.");
    setSaving(true);
    try {
      const payload = {
        name: draft.name,
        description: draft.description || null,
        selling_price: price,
        status: draft.status,
        items: draft.components.map((c) => ({ product_id: c.product_id, quantity: c.quantity })),
      };
      if (draft.id) await api(`/api/deals/${draft.id}`, { method: "PATCH", json: payload });
      else await api("/api/deals", { method: "POST", json: payload });
      setDialogOpen(false);
      refresh();
    } catch (e) {
      setDialogError(e instanceof ApiError ? e.message : "Could not save the deal.");
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (d: DealRow) => {
    const next = d.status === "active" ? "inactive" : "active";
    try {
      await api(`/api/deals/${d.id}`, { method: "PATCH", json: { status: next } });
      setNotice(next === "active" ? `${d.name} activated.` : `${d.name} deactivated — hidden from order forms.`);
      refresh();
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : "Could not update the deal.");
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      const res = await api<{ message?: string }>(`/api/deals/${deleting.id}`, { method: "DELETE" });
      setNotice(res?.message || `${deleting.name} deleted.`);
      setDeleting(null);
      refresh();
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : "Could not delete the deal.");
      setDeleting(null);
    }
  };

  if (loading) return <PageSpinner />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  const columns: Column<DealRow>[] = [
    {
      key: "name",
      header: "Deal",
      render: (d) => (
        <div>
          <p className="font-medium">{d.name}</p>
          {d.description ? <p className="text-xs text-muted-foreground">{d.description}</p> : null}
        </div>
      ),
    },
    {
      key: "components",
      header: "Components",
      hideInCard: true,
      render: (d) => (
        <div className="flex flex-wrap gap-1">
          {d.items.map((it) => (
            <Badge key={it.id} variant="outline" className="text-xs">
              {it.product_name} × {it.quantity}
            </Badge>
          ))}
        </div>
      ),
    },
    { key: "selling_price", header: "Bundle price", render: (d) => formatCurrency(d.selling_price) },
    {
      key: "available",
      header: "Buildable now",
      hideInCard: true,
      render: (d) => <span className="text-sm">{minBundleStock(d)}</span>,
    },
    {
      key: "status",
      header: "Status",
      render: (d) =>
        d.status === "active" ? (
          <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">Active</Badge>
        ) : d.status === "inactive" ? (
          <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">Inactive</Badge>
        ) : (
          <Badge variant="outline" className="bg-muted text-muted-foreground">Archived</Badge>
        ),
    },
    {
      key: "actions",
      header: "",
      render: (d) =>
        isAdmin ? (
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="outline" onClick={() => openEdit(d)}>
              <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
            </Button>
            {d.status !== "archived" ? (
              <Button size="sm" variant="outline" onClick={() => void toggleStatus(d)}>
                {d.status === "active" ? "Deactivate" : "Activate"}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" className="text-rose-500 hover:text-rose-600" onClick={() => setDeleting(d)} aria-label="Delete deal">
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Deals & Bundles"
        description="Combine products into promotional bundles — orders snapshot the bundle price and reserve every component"
        actions={
          isAdmin ? (
            <Button onClick={openCreate}>
              <Plus className="mr-1.5 h-4 w-4" /> New deal
            </Button>
          ) : null
        }
      />

      {notice ? (
        <div role="status" className="flex items-start justify-between gap-3 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="text-sky-700 hover:text-sky-900" aria-label="Dismiss notice">×</button>
        </div>
      ) : null}

      <Card>
        <CardContent className="p-0">
          <DataTable
            columns={columns}
            rows={deals}
            loading={loading}
            error={error}
            onRetry={refresh}
            emptyTitle="No deals yet"
            emptyDescription={isAdmin ? "Create a bundle to sell several products together at one promotional price." : undefined}
          />
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{draft.id ? `Edit deal ${draft.name}` : "New deal"}</DialogTitle>
            <DialogDescription>
              The bundle sells at ONE promotional price. Orders snapshot the price and components — later edits never
              change historical orders.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="mb-1.5 block">Name *</Label>
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Ramadan Skincare Bundle" />
              </div>
              <div>
                <Label className="mb-1.5 block">Selling price (Rs) *</Label>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={draft.selling_price}
                  onChange={(e) => setDraft({ ...draft, selling_price: e.target.value })}
                  placeholder="2999"
                />
              </div>
            </div>
            <div>
              <Label className="mb-1.5 block">Description</Label>
              <Textarea rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Optional — shown on the order form" />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Component products *</Label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setDraft((d) => ({ ...d, components: [...d.components, { key: Date.now(), product_id: "", quantity: 1 }] }))}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" /> Add component
                </Button>
              </div>
              {draft.components.map((c, idx) => {
                const p = lookup?.products.find((x) => x.id === c.product_id);
                return (
                  <div key={c.key} className="grid grid-cols-12 items-end gap-2 rounded-lg border border-border p-2.5">
                    <div className="col-span-12 sm:col-span-7">
                      <Label className="mb-1 block text-xs">Product {idx + 1}</Label>
                      <Select value={c.product_id} onValueChange={(v) => setDraft((d) => ({ ...d, components: d.components.map((x) => (x.key === c.key ? { ...x, product_id: v } : x)) }))}>
                        <SelectTrigger className="w-full"><SelectValue placeholder="Select product" /></SelectTrigger>
                        <SelectContent>
                          {(lookup?.products ?? []).map((p2) => (
                            <SelectItem key={p2.id} value={p2.id}>{p2.name} ({p2.available_stock} avail.)</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="col-span-8 sm:col-span-3">
                      <Label className="mb-1 block text-xs">Qty per bundle</Label>
                      <Input
                        type="number"
                        min={1}
                        inputMode="numeric"
                        value={c.quantity}
                        onChange={(e) => setDraft((d) => ({ ...d, components: d.components.map((x) => (x.key === c.key ? { ...x, quantity: Math.max(1, parseInt(e.target.value || "1", 10) || 1) } : x)) }))}
                      />
                    </div>
                    <div className="col-span-4 flex justify-end sm:col-span-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-rose-500 hover:text-rose-600"
                        disabled={draft.components.length === 1}
                        onClick={() => setDraft((d) => ({ ...d, components: d.components.filter((x) => x.key !== c.key) }))}
                        aria-label="Remove component"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                    {p ? <p className="col-span-12 text-xs text-muted-foreground">Catalogue price: {formatCurrency(p.selling_price)} — the bundle price overrides it at order time.</p> : null}
                  </div>
                );
              })}
            </div>

            {dialogError ? (
              <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">{dialogError}</p>
            ) : null}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>Cancel</Button>
              <Button onClick={() => void save()} disabled={saving}>
                {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Package className="mr-2 h-4 w-4" />}
                {draft.id ? "Save changes" : "Create deal"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={deleting ? `Delete deal ${deleting.name}?` : ""}
        description={
          deleting
            ? deleting.items.length && deals.some((d) => d.id === deleting.id)
              ? "Deals already used by orders are archived instead of deleted — historical order lines keep their snapshots either way."
              : "This permanently removes the deal and its component list. This cannot be undone."
            : ""
        }
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          await remove();
        }}
      />
    </div>
  );
}
