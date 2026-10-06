import { ok, withAuth, parseListParams } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import { lowStockProducts } from "@/lib/services/inventory";
import type { Product } from "@/lib/types";

/** Current stock view: products with availability + low-stock flag. Staff-only (exposes cost data). */
export const GET = withAuth(["super_admin", "admin", "inventory_manager"], async (_session, req) => {
  const url = new URL(req.url);
  const view = url.searchParams.get("view") || "current";
  if (view === "low") {
    const low = await lowStockProducts(10);
    return ok({ rows: low, total: low.length });
  }
  const opts = parseListParams(url, "created_at", ["name", "sku"]);
  const { rows, total } = await store.list<Product>("products", opts);
  const enriched = rows.map((p) => ({
    ...p,
    available_stock: p.current_stock - p.reserved_stock,
    stock_value: p.current_stock * p.purchase_price,
    low: p.current_stock - p.reserved_stock <= p.min_stock,
  }));
  return ok({ rows: enriched, total, page: opts.page, perPage: opts.perPage });
});
