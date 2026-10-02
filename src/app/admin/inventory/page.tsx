"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useList, buildQuery, useDebounced } from "@/lib/client";
import { PageHeader } from "@/components/app/states";
import { SearchInput } from "@/components/app/filters";
import { DataTable, type Column } from "@/components/app/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";

interface StockRow {
  id: string;
  name: string;
  sku: string;
  category_name: string | null;
  purchase_price: number;
  current_stock: number;
  reserved_stock: number;
  available_stock: number;
  min_stock: number;
  stock_value: number;
  low: boolean;
}

export default function CurrentStockPage() {
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search);
  const [page, setPage] = useState(1);
  const { data, loading, error, refresh } = useList<StockRow>(
    `/api/inventory${buildQuery({ search: debounced, page, perPage: 15 })}`,
    [debounced, page]
  );

  const totals = useMemo(() => {
    const rows = data?.rows ?? [];
    return {
      value: rows.reduce((s, p) => s + p.stock_value, 0),
      units: rows.reduce((s, p) => s + p.current_stock, 0),
      low: rows.filter((p) => p.low).length,
    };
  }, [data]);

  const columns: Column<StockRow>[] = [
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
    { key: "current_stock", header: "On hand" },
    { key: "reserved_stock", header: "Reserved", hideInCard: true },
    {
      key: "available_stock",
      header: "Available",
      render: (p) => (
        <div className="flex items-center gap-1.5">
          <span className="font-semibold">{p.available_stock}</span>
          {p.low ? <Badge className="bg-amber-100 text-[10px] text-amber-700">LOW</Badge> : null}
        </div>
      ),
    },
    { key: "min_stock", header: "Min", hideInCard: true },
    { key: "stock_value", header: "Value", render: (p) => formatCurrency(p.stock_value), hideInCard: true },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Current Stock"
        description={`On hand ${totals.units} units · stock value ${formatCurrency(totals.value)} · ${totals.low} low (page view)`}
        actions={
          <Button asChild variant="outline">
            <Link href="/admin/inventory/history">Full history</Link>
          </Button>
        }
      />

      <DataTable
        columns={columns}
        rows={data?.rows}
        loading={loading}
        error={error}
        onRetry={refresh}
        emptyTitle="No products"
        emptyDescription="Add products first, then track stock here."
        page={page}
        perPage={15}
        total={data?.total ?? 0}
        onPageChange={setPage}
        toolbar={
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search product or SKU…" className="lg:w-80" />
        }
      />
    </div>
  );
}
