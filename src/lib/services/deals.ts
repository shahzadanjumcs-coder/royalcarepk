import { store } from "@/lib/store";
import type { Actor } from "./audit";
import { logAudit } from "./audit";
import type { Deal, DealItem } from "@/lib/types";

export class DealError extends Error {}

export type DealStatus = Deal["status"];

export interface DealComponentInput {
  product_id: string;
  quantity: number;
}

export interface DealInput {
  name: string;
  description?: string | null;
  selling_price: number;
  status?: DealStatus;
  items: DealComponentInput[];
}

/**
 * Deals / bundles service.
 *
 * A deal is a named bundle of existing products with ONE promotional selling
 * price. Orders snapshot the deal (name + price + component list) at order
 * time — later deal edits never rewrite historical orders, and the inventory
 * lifecycle expands the bundle's components exactly as they were sold.
 */

/** Validate component list and resolve live product data for a deal payload. */
async function resolveComponents(items: DealComponentInput[]): Promise<Map<string, { name: string; sku: string; quantity: number }>> {
  if (!Array.isArray(items) || items.length === 0) throw new DealError("A deal needs at least one component product.");
  const resolved = new Map<string, { name: string; sku: string; quantity: number }>();
  for (const item of items) {
    const qty = Math.floor(Number(item?.quantity));
    if (!qty || qty <= 0) throw new DealError("Component quantities must be positive numbers.");
    if (resolved.has(item.product_id)) throw new DealError("Each product can appear only once per deal.");
    const product = await store.get<{ id: string; name: string; sku: string; status: string }>("products", item.product_id);
    if (!product) throw new DealError("One of the component products was not found.");
    if (product.status !== "active") throw new DealError(`Product "${product.name}" is inactive and cannot be part of a deal.`);
    resolved.set(item.product_id, { name: product.name, sku: product.sku, quantity: qty });
  }
  return resolved;
}

export async function createDeal(session: Actor, input: DealInput): Promise<Deal> {
  const name = String(input.name ?? "").trim();
  if (!name) throw new DealError("Deal name is required.");
  const price = Number(input.selling_price);
  if (!Number.isFinite(price) || price < 0) throw new DealError("Selling price cannot be negative.");
  const status: DealStatus = input.status === "inactive" || input.status === "archived" ? input.status : "active";

  const components = await resolveComponents(input.items);
  const deal = await store.insert<Deal>("deals", {
    name,
    description: input.description?.trim() || null,
    selling_price: price,
    status,
    created_by: session.userId ?? null,
  });
  for (const [product_id, c] of components) {
    await store.insert("deal_items", { deal_id: deal.id, product_id, quantity: c.quantity });
  }
  await logAudit({
    session,
    action: "deal.created",
    entity: "deals",
    entityId: deal.id,
    newData: { name, selling_price: price, status, components: [...components.values()] },
  });
  return deal;
}

export async function updateDeal(session: Actor, dealId: string, input: Partial<DealInput>): Promise<Deal> {
  const existing = await store.get<Deal>("deals", dealId);
  if (!existing) throw new DealError("Deal not found.");

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (!name) throw new DealError("Deal name is required.");
    patch.name = name;
  }
  if (input.description !== undefined) patch.description = input.description?.trim() || null;
  if (input.selling_price !== undefined) {
    const price = Number(input.selling_price);
    if (!Number.isFinite(price) || price < 0) throw new DealError("Selling price cannot be negative.");
    patch.selling_price = price;
  }
  if (input.status !== undefined) {
    if (!["active", "inactive", "archived"].includes(input.status)) throw new DealError("Invalid deal status.");
    patch.status = input.status;
  }

  if (input.items !== undefined) {
    const components = await resolveComponents(input.items);
    const existingItems = await store.list<DealItem>("deal_items", { filters: { deal_id: dealId } });
    for (const row of existingItems.rows) await store.delete("deal_items", row.id);
    for (const [product_id, c] of components) {
      await store.insert("deal_items", { deal_id: dealId, product_id, quantity: c.quantity });
    }
  }

  patch.updated_at = new Date().toISOString();
  await store.update("deals", dealId, patch);
  await logAudit({
    session,
    action: "deal.updated",
    entity: "deals",
    entityId: dealId,
    oldData: { name: existing.name, selling_price: existing.selling_price, status: existing.status },
    newData: patch,
  });
  return { ...existing, ...(patch as Partial<Deal>) };
}

/**
 * Hard-delete ONLY when no order ever used the deal — historical order lines
 * keep their snapshots (order_items.deal_id is SET NULL), but a deal with
 * order references is retired via status "archived" instead.
 */
export async function deleteDeal(session: Actor, dealId: string): Promise<{ deleted: boolean; archived: boolean }> {
  const existing = await store.get<Deal>("deals", dealId);
  if (!existing) throw new DealError("Deal not found.");
  const used = await store.count("order_items", { deal_id: dealId });
  if (used > 0) {
    await updateDeal(session, dealId, { status: "archived" });
    return { deleted: false, archived: true };
  }
  await store.delete("deals", dealId); // deal_items cascade (migration 0009)
  await logAudit({ session, action: "deal.deleted", entity: "deals", entityId: dealId, oldData: { name: existing.name } });
  return { deleted: true, archived: false };
}

/** Deal with its component products resolved (for admin UI / lookup). */
export async function getDealWithItems(dealId: string): Promise<(Deal & { items: (DealItem & { product_name: string; available_stock: number })[] }) | null> {
  const deal = await store.get<Deal>("deals", dealId);
  if (!deal) return null;
  const { rows: items } = await store.list<DealItem>("deal_items", { filters: { deal_id: dealId } });
  const withProducts = await Promise.all(
    items.map(async (it) => {
      const p = await store.get<{ name: string; current_stock: number; reserved_stock: number }>("products", it.product_id);
      return {
        ...it,
        product_name: p?.name ?? "—",
        available_stock: p ? p.current_stock - p.reserved_stock : 0,
      };
    })
  );
  return { ...deal, items: withProducts };
}

export async function listDealsWithItems(opts?: { statuses?: DealStatus[] }): Promise<(Deal & { items: (DealItem & { product_name: string; sku: string; available_stock: number })[] })[]> {
  const { rows } = await store.list<Deal>("deals", { orderBy: { field: "created_at", dir: "desc" } });
  const filtered = opts?.statuses ? rows.filter((d) => opts.statuses!.includes(d.status)) : rows;
  const { rows: allItems } = await store.list<DealItem>("deal_items");
  const itemsByDeal = new Map<string, DealItem[]>();
  for (const it of allItems) {
    const list = itemsByDeal.get(it.deal_id) ?? [];
    list.push(it);
    itemsByDeal.set(it.deal_id, list);
  }
  return Promise.all(
    filtered.map(async (d) => {
      const items = await Promise.all(
        (itemsByDeal.get(d.id) ?? []).map(async (it) => {
          const p = await store.get<{ name: string; sku: string; current_stock: number; reserved_stock: number }>("products", it.product_id);
          return {
            ...it,
            product_name: p?.name ?? "—",
            sku: p?.sku ?? "",
            available_stock: p ? p.current_stock - p.reserved_stock : 0,
          };
        })
      );
      return { ...d, items };
    })
  );
}

/**
 * Resolve a deal for an order line (order-time snapshot). The deal must be
 * active — inactive/archived deals cannot be added to new orders. The
 * returned component list IS the inventory requirement.
 */
export async function resolveDealForOrder(dealId: string, quantity: number): Promise<{
  deal_id: string;
  name: string;
  selling_price: number;
  components: { product_id: string; name: string; quantity: number }[];
}> {
  const qty = Math.floor(Number(quantity));
  if (!qty || qty <= 0) throw new DealError("Deal quantities must be positive numbers.");
  const deal = await store.get<Deal>("deals", dealId);
  if (!deal) throw new DealError("The selected deal was not found.");
  if (deal.status !== "active") throw new DealError(`Deal "${deal.name}" is not active and cannot be added to new orders.`);
  const { rows: items } = await store.list<DealItem>("deal_items", { filters: { deal_id: dealId } });
  if (!items.length) throw new DealError(`Deal "${deal.name}" has no components configured.`);
  const components: { product_id: string; name: string; quantity: number }[] = [];
  for (const it of items) {
    const product = await store.get<{ id: string; name: string; status: string }>("products", it.product_id);
    if (!product) throw new DealError(`A component of deal "${deal.name}" no longer exists.`);
    if (product.status !== "active") throw new DealError(`Component "${product.name}" of deal "${deal.name}" is inactive.`);
    components.push({ product_id: product.id, name: product.name, quantity: it.quantity * qty });
  }
  return { deal_id: deal.id, name: deal.name, selling_price: Number(deal.selling_price), components };
}
