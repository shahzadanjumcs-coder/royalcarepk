"use client";

import { ResourceManager } from "@/components/app/resource-manager";
import { useApi } from "@/lib/client";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/app/data-table";
import { formatCurrency } from "@/lib/utils";

interface ProductRow {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  category_id: string | null;
  supplier_id: string | null;
  category_name: string | null;
  supplier_name: string | null;
  purchase_price: number;
  selling_price: number;
  current_stock: number;
  reserved_stock: number;
  available_stock: number;
  min_stock: number;
  status: string;
}

export default function ProductsPage() {
  const { data: cats, refresh: refreshCats } = useApi<{ rows: { id: string; name: string }[] }>("/api/categories");
  const { data: sups, refresh: refreshSups } = useApi<{ rows: { id: string; name: string }[] }>("/api/suppliers");

  const columns: Column<ProductRow>[] = [
    {
      key: "name",
      header: "Product",
      render: (p) => (
        <div>
          <p className="font-medium">{p.name}</p>
          <p className="text-xs text-muted-foreground">{p.sku}</p>
        </div>
      ),
    },
    { key: "category_name", header: "Category", render: (p) => p.category_name ?? "—", hideInCard: true },
    { key: "supplier_name", header: "Supplier", render: (p) => p.supplier_name ?? "—", hideInCard: true },
    { key: "purchase_price", header: "Cost", render: (p) => formatCurrency(p.purchase_price) },
    { key: "selling_price", header: "Price", render: (p) => formatCurrency(p.selling_price) },
    {
      key: "stock",
      header: "Stock",
      render: (p) => (
        <div className="flex items-center gap-1.5">
          <span className="font-semibold">{p.available_stock}</span>
          <span className="text-xs text-muted-foreground">avail.</span>
          {p.reserved_stock > 0 ? <Badge variant="outline" className="text-[10px]">{p.reserved_stock} reserved</Badge> : null}
          {p.available_stock <= p.min_stock ? <Badge className="bg-amber-100 text-[10px] text-amber-700">LOW</Badge> : null}
        </div>
      ),
    },
    { key: "status", header: "Status", render: (p) => <span className="capitalize text-xs">{p.status}</span>, hideInCard: true },
  ];

  return (
    <ResourceManager<ProductRow>
      title="Products"
      description="Catalog with pricing and live stock positions"
      endpoint="/api/products"
      searchPlaceholder="Search name, SKU, barcode…"
      searchFields={["name", "sku", "barcode"]}
      emptyTitle="No products yet"
      emptyDescription="Add products to start taking orders and tracking stock."
      createLabel="Add product"
      columns={columns}
      fields={[
        { name: "name", label: "Product name", type: "text", required: true },
        { name: "sku", label: "SKU", type: "text", required: true, placeholder: "SKU-0001" },
        { name: "barcode", label: "Barcode", type: "text" },
        { name: "category_id", label: "Category", type: "select", options: [{ value: "none", label: "None" }, ...(cats?.rows ?? []).map((c) => ({ value: c.id, label: c.name }))] },
        { name: "supplier_id", label: "Supplier", type: "select", options: [{ value: "none", label: "None" }, ...(sups?.rows ?? []).map((s) => ({ value: s.id, label: s.name }))] },
        { name: "purchase_price", label: "Purchase price (Rs)", type: "number", required: true, min: 0 },
        { name: "selling_price", label: "Selling price (Rs)", type: "number", required: true, min: 1 },
        { name: "current_stock", label: "Opening stock", type: "number", min: 0, defaultValue: 0, hint: "Recorded as a PURCHASE movement" },
        { name: "min_stock", label: "Minimum stock", type: "number", min: 0, defaultValue: 5 },
      ]}
      transformSubmit={(v) => ({
        ...v,
        purchase_price: Number(v.purchase_price ?? 0),
        selling_price: Number(v.selling_price ?? 0),
        current_stock: Number(v.current_stock ?? 0),
        min_stock: Number(v.min_stock ?? 0),
        category_id: !v.category_id || v.category_id === "none" ? null : v.category_id,
        supplier_id: !v.supplier_id || v.supplier_id === "none" ? null : v.supplier_id,
      })}
      mapRowToForm={(p) => ({
        name: p.name,
        sku: p.sku,
        barcode: p.barcode ?? "",
        category_id: p.category_id ?? "none",
        supplier_id: p.supplier_id ?? "none",
        purchase_price: p.purchase_price,
        selling_price: p.selling_price,
        min_stock: p.min_stock,
      })}
      onUpdate={async (row, values) => {
        const { api } = await import("@/lib/client");
        await api(`/api/products/${row.id}`, { method: "PATCH", json: values });
        refreshCats();
        refreshSups();
      }}
      onDelete={async (row) => {
        const { api } = await import("@/lib/client");
        const res = await api<{ message?: string }>(`/api/products/${row.id}`, { method: "DELETE" });
        return res.message;
      }}
    />
  );
}
