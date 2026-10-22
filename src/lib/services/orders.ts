import { store } from "@/lib/store";
import type { Order, OrderStatus } from "@/lib/types";
import type { Actor } from "./audit";
import { reserveForOrder, finalizeForOrder, restoreForOrder, releaseForOrder, applyMovement } from "./inventory";
import { processCommissionForStatus } from "./commission";
import { resolveDealForOrder } from "./deals";
import { notifyAdmins, notifyWorker } from "./notifications";
import { logAudit } from "./audit";
import { enqueueWhatsAppOrderEvent } from "./whatsapp";
import { TRANSITIONS, canTransition } from "./order_transitions";
import { isValidPhone } from "@/lib/utils";

// Re-exported so the rest of the app keeps a single import path for the
// transition rules (the canonical definition lives in ./order_transitions).
export { TRANSITIONS, canTransition };

export class OrderError extends Error {}

/** Roles allowed to approve / reject worker orders. Workers can NEVER approve. */
export const APPROVAL_ROLES = ["super_admin", "admin"] as const;

export function canApprove(role: string | undefined): boolean {
  return role === "super_admin" || role === "admin";
}

/** Allowed status transitions (pragmatic courier workflow) — see ./order_transitions. */

export async function generateOrderNumber(): Promise<string> {
  const now = new Date();
  const dayKey = now.toISOString().slice(0, 10);
  const { total } = await store.list("orders", {
    dateRange: { field: "created_at", from: dayKey, to: dayKey },
  });
  const seq = String(total + 1).padStart(3, "0");
  const yy = dayKey.slice(2, 4), mm = dayKey.slice(5, 7), dd = dayKey.slice(8, 10);
  return `ORD-${yy}${mm}${dd}-${seq}`;
}

export interface CreateOrderInput {
  customer: { id?: string; name?: string; phone?: string; email?: string; address?: string; city?: string };
  items: { product_id?: string; deal_id?: string; quantity: number; unit_price?: number }[];
  discount: number;
  cod_amount?: number;
  delivery_address: string;
  city: string;
  notes?: string | null;
  worker_id?: string | null;
}

export async function createOrder(session: Actor, input: CreateOrderInput): Promise<Order> {
  // ---- validation (server-side; never trust client) ----
  if (!input.items?.length) throw new OrderError("At least one order item is required.");
  if (!input.delivery_address?.trim()) throw new OrderError("Delivery address is required.");
  if (!input.city?.trim()) throw new OrderError("Delivery city is required.");
  if (input.discount < 0) throw new OrderError("Discount cannot be negative.");

  // Worker submissions are priced at the catalogue price — the client's
  // unit_price/discount are NEVER trusted for workers. Deal lines are priced
  // at the deal's selling price for EVERY role (the bundle price is the
  // catalogue price of the bundle).
  const isWorkerSubmission = session.role === "worker";
  let subtotal = 0;
  const itemRows: {
    product_id: string | null;
    product_name: string;
    sku: string | null;
    quantity: number;
    unit_price: number;
    line_total: number;
    deal_id?: string | null;
    components?: { product_id: string; name: string; quantity: number }[] | null;
  }[] = [];
  for (const item of input.items) {
    const qty = Math.floor(Number(item.quantity));
    if (!qty || qty <= 0) throw new OrderError("Item quantities must be positive numbers.");

    // ---- deal/bundle line: snapshot the deal (name, price, components) ----
    if (item.deal_id) {
      if (item.product_id) throw new OrderError("An order line is either a product or a deal — not both.");
      const deal = await resolveDealForOrder(item.deal_id, qty);
      const lineTotal = deal.selling_price * qty;
      subtotal += lineTotal;
      itemRows.push({
        product_id: null,
        product_name: deal.name,
        sku: null,
        quantity: qty,
        unit_price: deal.selling_price,
        line_total: lineTotal,
        deal_id: deal.deal_id,
        components: deal.components,
      });
      continue;
    }

    const product = await store.get<{ id: string; name: string; sku: string; selling_price: number; status: string }>(
      "products",
      item.product_id as string
    );
    if (!product) throw new OrderError("One of the selected products was not found.");
    if (product.status !== "active") throw new OrderError(`Product "${product.name}" is inactive.`);
    const unit = isWorkerSubmission
      ? product.selling_price // catalogue price only — workers cannot set prices
      : Number(item.unit_price ?? product.selling_price);
    if (unit < 0) throw new OrderError("Unit price cannot be negative.");
    subtotal += unit * qty;
    itemRows.push({
      product_id: product.id,
      product_name: product.name,
      sku: product.sku,
      quantity: qty,
      unit_price: unit,
      line_total: unit * qty,
    });
  }

  // Every line must be either a product or a deal — reject empty lines.
  if (input.items.some((i) => !i.product_id && !i.deal_id)) {
    throw new OrderError("Every order line needs a product or a deal.");
  }
  const total = isWorkerSubmission ? subtotal : subtotal - input.discount;
  if (total < 0) throw new OrderError("Discount cannot exceed the order total.");

  // ---- customer: link existing or create/find by phone ----
  let customerId = input.customer.id;
  if (!customerId) {
    const phone = (input.customer.phone ?? "").trim();
    if (!input.customer.name?.trim()) throw new OrderError("Customer name is required.");
    if (!isValidPhone(phone)) throw new OrderError("A valid customer phone number is required.");
    const existing = await store.first("customers", { phone });
    if (existing) {
      customerId = existing.id;
    } else {
      const created = await store.insert("customers", {
        name: input.customer.name.trim(),
        phone,
        email: input.customer.email || null,
        address: input.customer.address || input.delivery_address,
        city: input.customer.city || input.city,
        status: "active",
      });
      customerId = created.id;
    }
  }

  // ---- worker + commission rate snapshot ----
  let workerId = input.worker_id || null;
  let commissionRate: number | null = null;
  if (workerId) {
    const worker = await store.get<{ id: string; role: string; status: string; commission_rate: number; name: string }>(
      "profiles",
      workerId
    );
    if (!worker || worker.role !== "worker" || worker.status !== "active") {
      throw new OrderError("Selected worker is not an active worker.");
    }
    commissionRate = worker.commission_rate;
  }

  // ---- approval workflow: worker-submitted orders start PENDING and must be
  // approved by an admin before Flaship booking. Orders created by admins are
  // inherently approved (existing behaviour preserved). A worker can only
  // create orders for themselves — the session decides, never the client. ----
  if (isWorkerSubmission) {
    workerId = session.userId!;
    const self = await store.get<{ id: string; role: string; status: string; commission_rate: number; name: string; email: string; worker_code: string | null }>(
      "profiles",
      workerId
    );
    if (!self || self.role !== "worker" || self.status !== "active") {
      throw new OrderError("Your worker account is not active.");
    }
    commissionRate = self.commission_rate;
  }

  // ---- create order ----
  const orderNumber = await generateOrderNumber();
  const nowIso = new Date().toISOString();
  const workerProfile = isWorkerSubmission
    ? await store.get<{ name: string; email: string; worker_code: string | null }>("profiles", workerId!)
    : null;
  const order = await store.insert<Order>("orders", {
    order_number: orderNumber,
    customer_id: customerId,
    worker_id: workerId,
    status: isWorkerSubmission ? "PENDING" : workerId ? "ASSIGNED" : "PENDING",
    subtotal,
    discount: input.discount,
    total,
    // COD = commission base (commission.ts derives commission from cod_amount).
    // Worker submissions NEVER trust the client's cod_amount — it is pinned to
    // the server-computed catalogue total, exactly like unit prices/discount.
    // Admins may still set an explicit COD amount (their own field in the form).
    cod_amount: isWorkerSubmission ? total : (input.cod_amount ?? total),
    delivery_address: input.delivery_address.trim(),
    city: input.city.trim(),
    notes: input.notes || null,
    commission_rate: commissionRate,
    commission_rate_locked_at: workerId ? new Date().toISOString() : null,
    booking_status: "not_booked",
    approval_status: isWorkerSubmission ? "PENDING" : "APPROVED",
    submitted_at: isWorkerSubmission ? nowIso : null,
    submitted_by: isWorkerSubmission ? session.userId : null,
    approved_at: isWorkerSubmission ? null : nowIso,
    approved_by: isWorkerSubmission ? null : session.userId,
    worker_name_snapshot: workerProfile?.name ?? null,
    worker_email_snapshot: workerProfile?.email ?? null,
    worker_code_snapshot: workerProfile?.worker_code ?? null,
    created_by: session.userId,
  });

  const insertedItemIds: string[] = [];
  for (const row of itemRows) {
    const created = await store.insert("order_items", { order_id: order.id, ...row });
    insertedItemIds.push(created.id);
  }

  const insertedHistoryIds: string[] = [];
  const historyInsert = await store.insert("order_status_history", {
    order_id: order.id,
    status: "CREATED",
    note: "Order created",
    created_by: session.userId,
  });
  insertedHistoryIds.push(historyInsert.id);
  if (workerId) {
    const assigned = await store.insert("order_status_history", {
      order_id: order.id,
      status: "ASSIGNED",
      note: "Worker assigned at creation",
      created_by: session.userId,
    });
    insertedHistoryIds.push(assigned.id);
  }

  // ---- reserve inventory (never permanently deduct at creation) ----
  // All availability was validated inside reserveForOrder BEFORE any write;
  // if it still fails, roll the fresh order rows back so a refused order can
  // never linger as a partial record (Phase 5: no partial order, no partial
  // reservation).
  try {
    await reserveForOrder(itemRows, order.id, orderNumber, session.userId);
  } catch (e) {
    for (const id of insertedItemIds) await store.delete("order_items", id);
    for (const id of insertedHistoryIds) await store.delete("order_status_history", id);
    await store.delete("orders", order.id);
    throw e;
  }

  // ---- side effects ----
  if (workerId && !isWorkerSubmission) {
    await notifyWorker(workerId, {
      title: "New order assigned",
      message: `Order ${orderNumber} has been assigned to you.`,
      type: "info",
      link: `/worker/orders/${order.id}`,
    });
  }
  if (isWorkerSubmission) {
    await notifyAdmins({
      title: "New order waiting for approval",
      message: `Worker ${workerProfile?.name ?? session.name ?? ""} submitted order ${orderNumber} (Rs ${total.toLocaleString()}) for approval.`,
      type: "info",
      link: `/admin/orders/${order.id}`,
    });
    await logAudit({
      session,
      action: "order.submitted",
      entity: "orders",
      entityId: order.id,
      newData: { order_number: orderNumber, total, worker_id: workerId, approval_status: "PENDING" },
    });
  } else {
    await notifyAdmins({
      title: "New order created",
      message: `Order ${orderNumber} (Rs ${total.toLocaleString()}) was created.`,
      type: "info",
      link: `/admin/orders/${order.id}`,
    });
  }
  await logAudit({
    session,
    action: "order.created",
    entity: "orders",
    entityId: order.id,
    newData: { order_number: orderNumber, total, worker_id: workerId, approval_status: isWorkerSubmission ? "PENDING" : "APPROVED" },
  });

  return order;
}

// ---------------- Admin order editing (Phase 3) ----------------

export interface AdminOrderUpdateInput {
  customer_id?: string;
  delivery_address?: string;
  city?: string;
  notes?: string | null;
  discount?: number;
  cod_amount?: number;
  /** Full replacement item list (order-time snapshots are rebuilt from it). */
  items?: { product_id: string; quantity: number; unit_price?: number }[];
}

/**
 * Admin edit of a not-yet-booked order (worker-created or admin-created).
 *
 * Scope & safety rules:
 * - Closed orders (DELIVERED / RETURNED / CANCELLED) are never editable —
 *   their stock, commission and shipment history is final.
 * - A booked order (CN exists / booking in flight) is immutable except for
 *   internal `notes`: the Flaship Integration API exposes NO shipment
 *   amendment endpoint (the official plugin only uses catalog/, bookings/
 *   and orders/{cn}/tracking/), so a local edit would silently desync the
 *   courier label from our record. The honest fix is cancel + rebook; the
 *   error message says exactly that.
 * - Totals are ALWAYS recomputed server-side from the validated items —
 *   no client-supplied subtotal/total is ever trusted.
 * - Item price snapshots (product_name/sku/unit_price/line_total) are
 *   rebuilt, so later catalogue changes never rewrite historical orders.
 * - Stock reservations follow the item diff atomically-for-this-flow:
 *   availability for every net increase is validated BEFORE any write,
 *   releases are applied before reserves (releases only free stock, so a
 *   failed reserve can never leave stock over-reserved).
 * - Commission is untouched by pre-booking edits: it is credited on
 *   DELIVERED from the cod_amount present at that moment (rate snapshot on
 *   the order is never recalculated).
 * - PENDING-approval orders stay PENDING after an edit — approval is a
 *   separate explicit action.
 */
export async function adminUpdateOrder(session: Actor, orderId: string, input: AdminOrderUpdateInput): Promise<Order> {
  const order = await store.get<Order>("orders", orderId);
  if (!order) throw new OrderError("Order not found.");

  if (["DELIVERED", "RETURNED", "CANCELLED"].includes(order.status)) {
    throw new OrderError("Closed orders cannot be edited.");
  }
  const isBooked = !!(order.tracking_number || order.flaship_booking_id || order.booking_status === "booked" || order.booking_status === "pending");
  if (isBooked) {
    const onlyNotes = input.items === undefined && input.customer_id === undefined && input.delivery_address === undefined && input.city === undefined && input.discount === undefined && input.cod_amount === undefined;
    if (!onlyNotes) {
      throw new OrderError(
        `Order ${order.order_number} is already booked with the courier${order.tracking_number ? ` (CN ${order.tracking_number})` : ""}. The Flaship API has no shipment-amendment endpoint, so items, prices and the delivery address can no longer be edited here — cancel the order and create a corrected rebooking instead.`
      );
    }
  }

  // ---- optional customer relink ----
  let customerId = order.customer_id;
  if (input.customer_id !== undefined) {
    if (!input.customer_id) throw new OrderError("Select a valid customer.");
    const customer = await store.get("customers", input.customer_id);
    if (!customer) throw new OrderError("The selected customer was not found.");
    customerId = input.customer_id;
  }

  // ---- scalar fields (validated) ----
  const deliveryAddress = input.delivery_address !== undefined ? String(input.delivery_address).trim() : order.delivery_address;
  if (!deliveryAddress) throw new OrderError("Delivery address is required.");
  const city = input.city !== undefined ? String(input.city).trim() : order.city;
  if (!city) throw new OrderError("Delivery city is required.");

  // ---- items: validate everything BEFORE mutating anything ----
  interface PlannedItem { product_id: string; product_name: string; sku: string; quantity: number; unit_price: number; line_total: number }
  let plannedItems: PlannedItem[] | null = null;
  let dealLineTotal = 0; // preserved bundle lines keep contributing their snapshots
  if (input.items !== undefined) {
    if (!Array.isArray(input.items) || input.items.length === 0) throw new OrderError("At least one order item is required.");
    const existingRows = await store.list<{
      id: string;
      product_id: string | null;
      quantity: number;
      unit_price: number;
      line_total: number;
      deal_id?: string | null;
      components?: { product_id: string; name: string; quantity: number }[] | null;
    }>("order_items", {
      filters: { order_id: orderId },
    });
    // Deal/bundle lines are managed as a unit and are NOT editable through
    // this endpoint (change a bundle → cancel + rebook, or edit the deal).
    // They are preserved verbatim; their component reservations join the diff
    // below so regular-line edits cannot double-count the same stock.
    const dealRows = existingRows.rows.filter((r) => r.deal_id || (r.components && r.components.length));
    const regularRows = existingRows.rows.filter((r) => !dealRows.includes(r));
    const oldQtyByProduct = new Map<string, number>();
    const oldPriceByProduct = new Map<string, number>();
    for (const row of regularRows) {
      if (!row.product_id) continue;
      oldQtyByProduct.set(row.product_id, (oldQtyByProduct.get(row.product_id) ?? 0) + Number(row.quantity));
      if (!oldPriceByProduct.has(row.product_id)) oldPriceByProduct.set(row.product_id, Number(row.unit_price));
    }
    for (const row of dealRows) {
      for (const c of row.components ?? []) {
        oldQtyByProduct.set(c.product_id, (oldQtyByProduct.get(c.product_id) ?? 0) + Number(c.quantity));
      }
    }

    // consolidate planned quantities per product (the payload is a full replacement list)
    const newQtyByProduct = new Map<string, number>();
    const planned: Omit<PlannedItem, "product_name" | "sku" | "line_total">[] = [];
    for (const item of input.items) {
      const qty = Math.floor(Number(item?.quantity));
      if (!qty || qty <= 0) throw new OrderError("Item quantities must be positive numbers.");
      const unit = item.unit_price === undefined || item.unit_price === null ? undefined : Number(item.unit_price);
      if (unit !== undefined && (!Number.isFinite(unit) || unit < 0)) throw new OrderError("Unit prices cannot be negative.");
      newQtyByProduct.set(item.product_id, (newQtyByProduct.get(item.product_id) ?? 0) + qty);
      planned.push({ product_id: item.product_id, quantity: qty, unit_price: unit as number });
    }
    // the preserved deal lines keep requiring their components
    for (const row of dealRows) {
      for (const c of row.components ?? []) {
        newQtyByProduct.set(c.product_id, (newQtyByProduct.get(c.product_id) ?? 0) + Number(c.quantity));
      }
    }

    // resolve product data + defaults; availability check for every net increase
    type ProductStockRow = { id: string; name: string; sku: string; selling_price: number; status: string; current_stock: number; reserved_stock: number };
    const productCache = new Map<string, ProductStockRow>();
    for (const [productId] of newQtyByProduct) {
      let product = productCache.get(productId);
      if (!product) {
        const fetched = await store.get<ProductStockRow>("products", productId);
        if (!fetched) throw new OrderError("One of the selected products was not found.");
        if (fetched.status !== "active") throw new OrderError(`Product "${fetched.name}" is inactive.`);
        product = fetched;
        productCache.set(productId, product);
      }
    }
    for (const [productId, newQty] of newQtyByProduct) {
      const oldQty = oldQtyByProduct.get(productId) ?? 0;
      if (newQty > oldQty) {
        const product = productCache.get(productId)!;
        const available = product.current_stock - product.reserved_stock;
        const delta = newQty - oldQty;
        if (delta > available) {
          throw new OrderError(`Not enough available stock of "${product.name}" (${available} left) to increase the quantity by ${delta}.`);
        }
      }
    }

    plannedItems = planned.map((p) => {
      const product = productCache.get(p.product_id)!;
      // default: keep the order's existing price for a product already on the
      // order; otherwise the current catalogue price (admin privilege, same
      // as createOrder's admin path)
      const unit = p.unit_price !== undefined ? p.unit_price : (oldPriceByProduct.get(p.product_id) ?? product.selling_price);
      return { product_id: p.product_id, product_name: product.name, sku: product.sku, quantity: p.quantity, unit_price: unit, line_total: unit * p.quantity };
    });

    // ---- reservation diff (validation already done) ----
    // releases first (they only free stock), then reserves
    for (const [productId, oldQty] of oldQtyByProduct) {
      const newQty = newQtyByProduct.get(productId) ?? 0;
      if (newQty < oldQty) {
        await applyReservationDelta(orderId, order.order_number, productId, "ORDER_RELEASE", oldQty - newQty, session.userId);
      }
    }
    for (const [productId, newQty] of newQtyByProduct) {
      const oldQty = oldQtyByProduct.get(productId) ?? 0;
      if (newQty > oldQty) {
        await applyReservationDelta(orderId, order.order_number, productId, "ORDER_RESERVE", newQty - oldQty, session.userId);
      }
    }

    // ---- rewrite item snapshots (deal lines are preserved verbatim) ----
    dealLineTotal = dealRows.reduce((s, r) => s + Number(r.line_total ?? 0), 0);
    for (const row of regularRows) await store.delete("order_items", row.id);
    for (const row of plannedItems) await store.insert("order_items", { order_id: orderId, ...row });
  }

  // ---- totals: ALWAYS recomputed server-side ----
  let subtotal = order.subtotal;
  let total = order.total;
  let discount = order.discount;
  let codAmount = order.cod_amount;
  if (plannedItems) {
    // preserved deal lines keep contributing their (snapshotted) line totals
    subtotal = plannedItems.reduce((s, i) => s + i.line_total, 0) + dealLineTotal;
    discount = input.discount !== undefined ? Number(input.discount) : 0;
    if (!Number.isFinite(discount) || discount < 0) throw new OrderError("Discount cannot be negative.");
    if (discount > subtotal) throw new OrderError("Discount cannot exceed the order subtotal.");
    total = subtotal - discount;
    codAmount = input.cod_amount !== undefined ? Number(input.cod_amount) : total;
  } else if (input.discount !== undefined || input.cod_amount !== undefined) {
    // scalar-only pricing edit (no item change)
    if (input.discount !== undefined) {
      discount = Number(input.discount);
      if (!Number.isFinite(discount) || discount < 0) throw new OrderError("Discount cannot be negative.");
      if (discount > Number(order.subtotal)) throw new OrderError("Discount cannot exceed the order subtotal.");
      total = Number(order.subtotal) - discount;
      codAmount = input.cod_amount !== undefined ? Number(input.cod_amount) : total;
    }
    if (input.cod_amount !== undefined) {
      codAmount = Number(input.cod_amount);
    }
  }
  if (!Number.isFinite(codAmount) || codAmount < 0) throw new OrderError("COD amount cannot be negative.");

  const patch: Record<string, unknown> = {
    customer_id: customerId,
    delivery_address: deliveryAddress,
    city,
    subtotal,
    discount,
    total,
    cod_amount: codAmount,
  };
  if (input.notes !== undefined) patch.notes = input.notes;

  await store.update("orders", orderId, patch);
  await logAudit({
    session,
    action: "order.admin_edited",
    entity: "orders",
    entityId: orderId,
    oldData: {
      order_number: order.order_number,
      items: plannedItems ? "previous items replaced" : undefined,
      subtotal: order.subtotal,
      discount: order.discount,
      total: order.total,
      cod_amount: order.cod_amount,
      delivery_address: order.delivery_address,
      city: order.city,
      customer_id: order.customer_id,
    },
    newData: {
      items_changed: plannedItems !== null,
      item_count: plannedItems?.length,
      subtotal,
      discount,
      total,
      cod_amount: codAmount,
      delivery_address: deliveryAddress,
      city,
      customer_id: customerId,
      note_edited_only: isBooked,
    },
  });

  return { ...order, ...(patch as Partial<Order>) };
}

// ---------------- Worker self-service delivery edit (Phase 6) ----------------

export interface WorkerDeliveryUpdateInput {
  delivery_address?: string;
  city?: string;
  notes?: string | null;
}

/**
 * Worker edits the DELIVERY fields of their OWN order before booking.
 *
 * Deliberately narrow: workers can correct where/how to deliver (address,
 * city, notes) on orders assigned to them, but never prices, items, the
 * customer link or the customer master record — pricing and catalogue data
 * stay admin/server-authoritative. Booked orders are immutable here: the
 * Flaship Integration API has no amendment endpoint, so the honest path is
 * admin cancel + rebook (the error says exactly that).
 */
export async function workerUpdateOrderDelivery(
  session: Actor,
  orderId: string,
  input: WorkerDeliveryUpdateInput
): Promise<Order> {
  const order = await store.get<Order>("orders", orderId);
  if (!order) throw new OrderError("Order not found.");
  if (order.worker_id !== session.userId) {
    throw new OrderError("You do not have access to this order.");
  }
  if (["DELIVERED", "RETURNED", "CANCELLED"].includes(order.status)) {
    throw new OrderError("Closed orders cannot be edited.");
  }
  if (order.tracking_number || order.flaship_booking_id || order.booking_status === "booked" || order.booking_status === "pending") {
    throw new OrderError(
      `Order ${order.order_number} is already booked with the courier${order.tracking_number ? ` (CN ${order.tracking_number})` : ""} — the delivery details can no longer be changed here. Ask an admin to cancel and rebook the order if the address is wrong.`
    );
  }
  const deliveryAddress = input.delivery_address !== undefined ? String(input.delivery_address).trim() : order.delivery_address;
  const city = input.city !== undefined ? String(input.city).trim() : order.city;
  if (!deliveryAddress) throw new OrderError("Delivery address is required.");
  if (!city) throw new OrderError("Delivery city is required.");

  const patch: Record<string, unknown> = { delivery_address: deliveryAddress, city };
  if (input.notes !== undefined) patch.notes = input.notes || null;
  await store.update("orders", orderId, patch);
  await logAudit({
    session,
    action: "order.delivery_edited",
    entity: "orders",
    entityId: orderId,
    oldData: { delivery_address: order.delivery_address, city: order.city },
    newData: { delivery_address: deliveryAddress, city, worker_self_edit: true },
  });
  return { ...order, ...(patch as Partial<Order>) };
}

/** Reservation delta helper for admin edits (single product, signed type). */
async function applyReservationDelta(
  orderId: string,
  orderNumber: string,
  productId: string,
  type: "ORDER_RESERVE" | "ORDER_RELEASE",
  quantity: number,
  userId?: string | null
): Promise<void> {
  await applyMovement({
    productId,
    type,
    quantity,
    orderId,
    note: type === "ORDER_RESERVE" ? `Reservation increased for edited order ${orderNumber}` : `Reservation reduced for edited order ${orderNumber}`,
    userId,
  });
}

export async function assignWorker(session: Actor, orderId: string, workerId: string): Promise<void> {
  const order = await store.get<Order>("orders", orderId);
  if (!order) throw new OrderError("Order not found.");
  if (["DELIVERED", "RETURNED", "CANCELLED"].includes(order.status)) {
    throw new OrderError("Cannot assign a worker to a closed order.");
  }
  const worker = await store.get<{ id: string; role: string; status: string; commission_rate: number; name: string }>(
    "profiles",
    workerId
  );
  if (!worker || worker.role !== "worker") throw new OrderError("Selected user is not a worker.");
  if (worker.status !== "active") throw new OrderError("This worker is currently disabled.");

  await store.update("orders", orderId, {
    worker_id: workerId,
    commission_rate: worker.commission_rate,
    commission_rate_locked_at: new Date().toISOString(),
    status: order.status === "CREATED" || order.status === "PENDING" ? "ASSIGNED" : order.status,
  });
  await store.insert("order_status_history", {
    order_id: orderId,
    status: "ASSIGNED",
    note: `Assigned to ${worker.name}`,
    created_by: session.userId,
  });
  await notifyWorker(workerId, {
    title: "New order assigned",
    message: `Order ${order.order_number} has been assigned to you.`,
    type: "info",
    link: `/worker/orders/${orderId}`,
  });
  await logAudit({ session, action: "order.assigned", entity: "orders", entityId: orderId, newData: { worker_id: workerId, worker_name: worker.name } });
}

export async function changeOrderStatus(
  session: Actor,
  orderId: string,
  newStatus: OrderStatus,
  note?: string | null
): Promise<Order> {
  const order = await store.get<Order>("orders", orderId);
  if (!order) throw new OrderError("Order not found.");

  const allowed = TRANSITIONS[order.status] ?? [];
  if (!allowed.includes(newStatus)) {
    throw new OrderError(`Cannot change status from ${order.status} to ${newStatus}.`);
  }

  const previouslyDelivered = order.status === "DELIVERED" || (await store.first("order_status_history", { order_id: orderId, status: "DELIVERED" }) !== null);

  // ---- side effects BEFORE persisting status ----
  if (newStatus === "DELIVERED") {
    await finalizeForOrder(orderId, order.order_number, session.userId);
  }
  if (newStatus === "RETURNED") {
    if (previouslyDelivered) {
      // physical product received back into available stock
      await restoreForOrder(orderId, order.order_number, session.userId);
    } else {
      // never deducted from stock — just release the reservation
      await releaseForOrder(orderId, order.order_number, session.userId);
    }
  }
  if (newStatus === "CANCELLED" && ["CREATED", "PENDING", "ASSIGNED", "BOOKED"].includes(order.status)) {
    await releaseForOrder(orderId, order.order_number, session.userId);
  }

  await store.update("orders", orderId, { status: newStatus });

  await store.insert("order_status_history", {
    order_id: orderId,
    status: newStatus,
    note: note ?? null,
    created_by: session.userId,
  });

  // commission ledger (idempotent)
  await processCommissionForStatus(orderId, newStatus);

  if (order.worker_id) {
    const messages: Partial<Record<OrderStatus, string>> = {
      DELIVERED: `Order ${order.order_number} was delivered.`,
      RETURNED: `Order ${order.order_number} was returned.`,
      CANCELLED: `Order ${order.order_number} was cancelled.`,
      IN_TRANSIT: `Order ${order.order_number} is now in transit.`,
    };
    if (messages[newStatus]) {
      await notifyWorker(order.worker_id, {
        title: `Order ${newStatus === "DELIVERED" ? "delivered" : newStatus === "RETURNED" ? "returned" : "update"}`,
        message: messages[newStatus]!,
        type: newStatus === "DELIVERED" ? "success" : newStatus === "RETURNED" || newStatus === "CANCELLED" ? "warning" : "info",
        link: `/worker/orders/${orderId}`,
      });
    }
  }
  await logAudit({
    session,
    action: "order.status_changed",
    entity: "orders",
    entityId: orderId,
    oldData: { status: order.status },
    newData: { status: newStatus, note: note ?? null },
  });

  // WhatsApp notification fan-out (BOOKED -> customer, DELIVERED -> customer,
  // RETURNED -> admins). Never throws and is idempotent — a repeated event
  // cannot create a duplicate message. See services/whatsapp.ts.
  if (newStatus === "BOOKED" || newStatus === "DELIVERED" || newStatus === "RETURNED") {
    await enqueueWhatsAppOrderEvent({ orderId, type: newStatus });
  }

  return { ...order, status: newStatus };
}

/** Worker updates their own order status (restricted transitions). */
export async function workerUpdateStatus(
  session: Actor,
  orderId: string,
  newStatus: OrderStatus,
  note?: string | null
): Promise<void> {
  const order = await store.get<Order>("orders", orderId);
  if (!order) throw new OrderError("Order not found.");
  if (order.worker_id !== session.userId) {
    throw new OrderError("You can only update orders assigned to you.");
  }
  const workerAllowed: Partial<Record<OrderStatus, OrderStatus[]>> = {
    BOOKED: ["IN_TRANSIT"],
    IN_TRANSIT: ["DELIVERED", "RETURNED"],
  };
  const allowed = workerAllowed[order.status] ?? [];
  if (!allowed.includes(newStatus)) {
    throw new OrderError(`As a worker you cannot change status from ${order.status} to ${newStatus}.`);
  }
  await changeOrderStatus(session, orderId, newStatus, note ?? "Updated by worker");
}

// ============================================================
// Worker order approval workflow
// ============================================================

/**
 * Approve a worker-submitted order. Callers must be admin/super_admin (route
 * level). The order is marked APPROVED first; Flaship booking is triggered by
 * the route AFTER the approval is persisted. If booking fails the order stays
 * APPROVED and the error is surfaced for a safe retry.
 */
export async function approveOrder(session: Actor, orderId: string): Promise<Order> {
  if (!canApprove(session.role)) {
    throw new OrderError("Only admins can approve orders.");
  }
  const order = await store.get<Order>("orders", orderId);
  if (!order) throw new OrderError("Order not found.");

  const approval = order.approval_status ?? "APPROVED"; // rows created pre-migration are approved
  if (approval === "APPROVED") return order; // idempotent — safe to call again
  if (approval === "REJECTED") {
    throw new OrderError("This order was rejected and cannot be approved.");
  }
  // A PENDING-approval order can still be CANCELLED (cancel releases stock
  // without touching approval_status). Approving a cancelled order would
  // resurrect it into an inconsistent state — block it explicitly.
  if (order.status === "CANCELLED") {
    throw new OrderError("This order was cancelled and cannot be approved.");
  }

  const now = new Date().toISOString();
  const updated = await store.update<Order>("orders", orderId, {
    approval_status: "APPROVED",
    approved_by: session.userId ?? null,
    approved_at: now,
  });

  await store.insert("order_status_history", {
    order_id: orderId,
    status: order.status,
    note: `Approved by ${session.name ?? "admin"} — cleared for Flaship booking`,
    created_by: session.userId ?? null,
  });
  if (order.worker_id) {
    await notifyWorker(order.worker_id, {
      title: "Order approved",
      message: `Your order ${order.order_number} has been approved and submitted for courier booking.`,
      type: "success",
      link: `/worker/orders/${orderId}`,
    });
  }
  await logAudit({
    session,
    action: "order.approved",
    entity: "orders",
    entityId: orderId,
    oldData: { approval_status: "PENDING" },
    newData: { approval_status: "APPROVED", approved_at: now },
  });
  return updated;
}

/**
 * Reject a worker-submitted order with a mandatory reason. Rejecting also
 * cancels the order (releases the stock reservation) and notifies the worker
 * with the reason. Only PENDING orders can be rejected.
 */
export async function rejectOrder(session: Actor, orderId: string, reason: string): Promise<Order> {
  if (!canApprove(session.role)) {
    throw new OrderError("Only admins can reject orders.");
  }
  const trimmed = (reason ?? "").trim();
  if (!trimmed) {
    throw new OrderError("A rejection reason is required.");
  }
  const order = await store.get<Order>("orders", orderId);
  if (!order) throw new OrderError("Order not found.");

  const approval = order.approval_status ?? "APPROVED";
  if (approval !== "PENDING") {
    throw new OrderError("Only orders waiting for approval can be rejected.");
  }
  if (order.status === "CANCELLED") {
    throw new OrderError("This order is already cancelled.");
  }

  const now = new Date().toISOString();
  const updated = await store.update<Order>("orders", orderId, {
    approval_status: "REJECTED",
    rejected_by: session.userId ?? null,
    rejected_at: now,
    rejection_reason: trimmed,
  });

  await logAudit({
    session,
    action: "order.rejected",
    entity: "orders",
    entityId: orderId,
    oldData: { approval_status: "PENDING" },
    newData: { approval_status: "REJECTED", rejection_reason: trimmed, rejected_at: now },
  });

  // Cancel the order so the stock reservation is released and the courier
  // lifecycle is closed. approval_status keeps the REJECTED record.
  await changeOrderStatus(session, orderId, "CANCELLED", `Rejected by ${session.name ?? "admin"}: ${trimmed}`);

  if (order.worker_id) {
    await notifyWorker(order.worker_id, {
      title: "Order rejected",
      message: `Your order ${order.order_number} has been rejected. Reason: ${trimmed}`,
      type: "warning",
      link: `/worker/orders/${orderId}`,
    });
  }
  return updated;
}
