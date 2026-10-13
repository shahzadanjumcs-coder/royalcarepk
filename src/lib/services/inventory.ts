import { store } from "@/lib/store";
import type { MovementType } from "@/lib/types";

export class InventoryError extends Error {}

/**
 * Apply a stock movement to a product with reservation-aware bookkeeping.
 *
 * Model:
 *   current_stock  = physical stock on hand
 *   reserved_stock = held for active (created/booked/in-transit) orders
 *   available      = current_stock - reserved_stock
 *
 * Movement types:
 *   PURCHASE/STOCK_IN  → +current
 *   STOCK_OUT          → -current
 *   ADJUSTMENT         → ±current (delta passed as quantity)
 *   ORDER_RESERVE      → +reserved            (order created)
 *   ORDER_RELEASE      → -reserved            (order cancelled / returned before delivery)
 *   DELIVERY           → -current, -reserved  (order delivered: finalize deduction)
 *   RETURN             → +current             (returned physical stock received)
 */
export async function applyMovement(params: {
  productId: string;
  type: MovementType;
  quantity: number;
  orderId?: string | null;
  note?: string | null;
  userId?: string | null | undefined;
}): Promise<void> {
  const product = await store.get<{ id: string; current_stock: number; reserved_stock: number }>(
    "products",
    params.productId
  );
  if (!product) throw new InventoryError("Product not found.");

  let deltaCurrent = 0;
  let deltaReserved = 0;
  switch (params.type) {
    case "PURCHASE":
    case "STOCK_IN":
    case "RETURN":
      deltaCurrent = Math.abs(params.quantity);
      break;
    case "STOCK_OUT":
      deltaCurrent = -Math.abs(params.quantity);
      break;
    case "ADJUSTMENT":
      deltaCurrent = params.quantity; // signed delta
      break;
    case "ORDER_RESERVE":
      deltaReserved = Math.abs(params.quantity);
      break;
    case "ORDER_RELEASE":
      deltaReserved = -Math.abs(params.quantity);
      break;
    case "DELIVERY":
      deltaCurrent = -Math.abs(params.quantity);
      deltaReserved = -Math.abs(params.quantity);
      break;
    default:
      throw new InventoryError("Unknown movement type.");
  }

  const nextCurrent = product.current_stock + deltaCurrent;
  const nextReserved = product.reserved_stock + deltaReserved;
  if (nextCurrent < 0) {
    throw new InventoryError(
      `Insufficient stock: this action would take stock below zero (available now: ${product.current_stock - product.reserved_stock}).`
    );
  }
  if (nextReserved < 0) {
    // clamp — e.g. return of an order that was never reserved in this system
    return applyMovement({ ...params, type: params.type === "ORDER_RELEASE" ? "ORDER_RESERVE" : params.type, quantity: 0 });
  }

  await store.update("products", params.productId, {
    current_stock: nextCurrent,
    reserved_stock: nextReserved,
  });
  await store.insert("inventory_movements", {
    product_id: params.productId,
    order_id: params.orderId ?? null,
    type: params.type,
    quantity: deltaCurrent,
    reserved_change: deltaReserved,
    balance_after: nextCurrent,
    reserved_after: nextReserved,
    note: params.note ?? null,
    created_by: params.userId ?? null,
  });
}

/** One inventory requirement: either a plain product line or a bundle line with components. */
export interface InventoryRequirement {
  product_id: string | null;
  quantity: number;
  /** Deal/bundle component snapshot — when present, product_id/quantity are display-only. */
  components?: { product_id: string; quantity: number }[] | null;
}

/** Expand an order line into its concrete product requirements. */
function expandRequirement(item: InventoryRequirement): { product_id: string; quantity: number }[] {
  if (item.components && item.components.length) {
    return item.components.filter((c) => c.product_id);
  }
  return item.product_id ? [{ product_id: item.product_id, quantity: item.quantity }] : [];
}

/** Reserve stock for a newly created order (per item). */
export async function reserveForOrder(
  items: InventoryRequirement[],
  orderId: string,
  orderNumber: string,
  userId?: string | null
): Promise<void> {
  // ---- validate EVERY requirement FIRST (atomic: no partial reservation) ----
  // Deal bundles expand into their component products, so a bundle line can
  // fail on any component — nothing is applied unless everything fits.
  const requirements = items.flatMap(expandRequirement);
  const availability: { product_id: string; quantity: number; available: number; name: string }[] = [];
  for (const req of requirements) {
    const product = await store.get<{ id: string; name: string; current_stock: number; reserved_stock: number }>(
      "products",
      req.product_id
    );
    if (!product) throw new InventoryError("A product in this order no longer exists.");
    availability.push({
      product_id: req.product_id,
      quantity: req.quantity,
      available: product.current_stock - product.reserved_stock,
      name: product.name,
    });
  }
  // aggregate per product (two lines may require the same product)
  const needByProduct = new Map<string, { quantity: number; available: number; name: string }>();
  for (const a of availability) {
    const prev = needByProduct.get(a.product_id);
    needByProduct.set(a.product_id, {
      quantity: (prev?.quantity ?? 0) + a.quantity,
      available: a.available,
      name: a.name,
    });
  }
  for (const [productId, need] of needByProduct) {
    if (need.quantity > need.available) {
      throw new InventoryError(`Not enough available stock of "${need.name}" (${need.available} left) to reserve ${need.quantity}.`);
    }
  }
  // ---- all fits — apply ----
  for (const req of requirements) {
    await applyMovement({
      productId: req.product_id,
      type: "ORDER_RESERVE",
      quantity: req.quantity,
      orderId,
      note: `Reserved for ${orderNumber}`,
      userId,
    });
  }
}

/** Release reservations (order cancelled, or returned before delivery). */
export async function releaseForOrder(
  orderId: string,
  orderNumber: string,
  userId?: string | null
): Promise<void> {
  const items = await store.list<InventoryRequirement>("order_items", {
    filters: { order_id: orderId },
  });
  for (const item of items.rows) {
    for (const req of expandRequirement(item)) {
      await applyMovement({
        productId: req.product_id,
        type: "ORDER_RELEASE",
        quantity: req.quantity,
        orderId,
        note: `Reservation released for ${orderNumber}`,
        userId,
      });
    }
  }
}

/** Finalize deduction on delivery (per item). */
export async function finalizeForOrder(
  orderId: string,
  orderNumber: string,
  userId?: string | null
): Promise<void> {
  const items = await store.list<InventoryRequirement>("order_items", {
    filters: { order_id: orderId },
  });
  for (const item of items.rows) {
    for (const req of expandRequirement(item)) {
      await applyMovement({
        productId: req.product_id,
        type: "DELIVERY",
        quantity: req.quantity,
        orderId,
        note: `Finalized for delivered order ${orderNumber}`,
        userId,
      });
    }
  }
}

/** Restore physical stock when a returned parcel is received back. */
export async function restoreForOrder(
  orderId: string,
  orderNumber: string,
  userId?: string | null
): Promise<void> {
  const items = await store.list<InventoryRequirement>("order_items", {
    filters: { order_id: orderId },
  });
  for (const item of items.rows) {
    for (const req of expandRequirement(item)) {
      await applyMovement({
        productId: req.product_id,
        type: "RETURN",
        quantity: req.quantity,
        orderId,
        note: `Return received for ${orderNumber}`,
        userId,
      });
    }
  }
}

export async function lowStockProducts(threshold: number) {
  const { rows } = await store.list<{ id: string; name: string; sku: string; current_stock: number; reserved_stock: number; min_stock: number }>(
    "products",
    { filters: { status: "active" } }
  );
  return rows.filter((p) => p.current_stock - p.reserved_stock <= Math.max(p.min_stock, threshold));
}
