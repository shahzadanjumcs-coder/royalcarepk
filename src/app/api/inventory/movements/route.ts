import { ok, withAuth, parseListParams } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import type { InventoryMovement } from "@/lib/types";

/** Stock movement history (PURCHASE / ORDER / RETURN / ADJUSTMENT …). */
export const GET = withAuth(["super_admin", "admin", "inventory_manager"], async (_session, req) => {
  const url = new URL(req.url);
  const opts = parseListParams(url, "created_at", ["note"]);
  if (url.searchParams.get("type")) opts.filters!.type = url.searchParams.get("type");
  if (url.searchParams.get("product_id")) opts.filters!.product_id = url.searchParams.get("product_id");
  if (url.searchParams.get("order_id")) opts.filters!.order_id = url.searchParams.get("order_id");

  const { rows, total } = await store.list<InventoryMovement>("inventory_movements", opts);
  const { rows: products } = await store.list<{ id: string; name: string; sku: string }>("products");
  const { rows: orders } = await store.list<{ id: string; order_number: string }>("orders");
  const { rows: profiles } = await store.list<{ id: string; name: string }>("profiles");
  const pMap = new Map(products.map((p) => [p.id, p]));
  const oMap = new Map(orders.map((o) => [o.id, o]));
  const uMap = new Map(profiles.map((u) => [u.id, u.name]));
  const enriched = rows.map((m) => ({
    ...m,
    product_name: pMap.get(m.product_id)?.name ?? "—",
    product_sku: pMap.get(m.product_id)?.sku ?? "—",
    order_number: m.order_id ? (oMap.get(m.order_id)?.order_number ?? null) : null,
    created_by_name: m.created_by ? (uMap.get(m.created_by) ?? null) : null,
  }));
  return ok({ rows: enriched, total, page: opts.page, perPage: opts.perPage });
});
