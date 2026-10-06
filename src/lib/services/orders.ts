import { store } from "@/lib/store";
import type { Order, OrderStatus } from "@/lib/types";
import type { Actor } from "./audit";
import { reserveForOrder, finalizeForOrder, restoreForOrder, releaseForOrder } from "./inventory";
import { processCommissionForStatus } from "./commission";
import { notifyAdmins, notifyWorker } from "./notifications";
import { logAudit } from "./audit";
import { enqueueWhatsAppOrderEvent } from "./whatsapp";
import { isValidPhone } from "@/lib/utils";

export class OrderError extends Error {}

/** Roles allowed to approve / reject worker orders. Workers can NEVER approve. */
export const APPROVAL_ROLES = ["super_admin", "admin"] as const;

export function canApprove(role: string | undefined): boolean {
  return role === "super_admin" || role === "admin";
}

/** Allowed status transitions (pragmatic courier workflow). */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  CREATED: ["PENDING", "ASSIGNED", "CANCELLED"],
  PENDING: ["ASSIGNED", "BOOKED", "CANCELLED"],
  ASSIGNED: ["PENDING", "BOOKED", "CANCELLED"],
  BOOKED: ["IN_TRANSIT", "RETURNED", "CANCELLED"],
  IN_TRANSIT: ["DELIVERED", "RETURNED"],
  DELIVERED: ["RETURNED"],
  RETURNED: [],
  CANCELLED: [],
};

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
  items: { product_id: string; quantity: number; unit_price: number }[];
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
  // unit_price/discount are NEVER trusted for workers.
  const isWorkerSubmission = session.role === "worker";
  const productIds = input.items.map((i) => i.product_id);
  let subtotal = 0;
  const itemRows: { product_id: string; product_name: string; sku: string; quantity: number; unit_price: number; line_total: number }[] = [];
  for (const item of input.items) {
    const product = await store.get<{ id: string; name: string; sku: string; selling_price: number; status: string }>(
      "products",
      item.product_id
    );
    if (!product) throw new OrderError("One of the selected products was not found.");
    if (product.status !== "active") throw new OrderError(`Product "${product.name}" is inactive.`);
    const qty = Math.floor(Number(item.quantity));
    if (!qty || qty <= 0) throw new OrderError("Item quantities must be positive numbers.");
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

  for (const row of itemRows) {
    await store.insert("order_items", { order_id: order.id, ...row });
  }

  await store.insert("order_status_history", {
    order_id: order.id,
    status: "CREATED",
    note: "Order created",
    created_by: session.userId,
  });
  if (workerId) {
    await store.insert("order_status_history", {
      order_id: order.id,
      status: "ASSIGNED",
      note: "Worker assigned at creation",
      created_by: session.userId,
    });
  }

  // ---- reserve inventory (never permanently deduct at creation) ----
  await reserveForOrder(itemRows, order.id, orderNumber, session.userId);

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
