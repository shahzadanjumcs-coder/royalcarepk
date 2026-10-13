import { ok, fail, withAuth, GENERIC_ERROR } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import { adminUpdateOrder, workerUpdateOrderDelivery, OrderError, type AdminOrderUpdateInput } from "@/lib/services/orders";
import type { Order } from "@/lib/types";
import { z } from "zod";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withAuth("any", async (session, _req, ctx) => {
  const { id } = await (ctx as unknown as Ctx).params;
  const order = await store.get<Order>("orders", id);
  if (!order) return fail("Order not found.", 404);
  if (session.role === "worker" && order.worker_id !== session.userId) {
    return fail("You do not have access to this order.", 403);
  }

  const [items, history, customer, worker, shipment, tracking, commission] = await Promise.all([
    // order_items has no created_at column — use stable id order (display-only list)
    store.list("order_items", { filters: { order_id: id }, orderBy: { field: "id", dir: "asc" } }),
    store.list("order_status_history", { filters: { order_id: id }, orderBy: { field: "created_at", dir: "asc" } }),
    store.get("customers", order.customer_id),
    order.worker_id ? store.get("profiles", order.worker_id) : Promise.resolve(null),
    store.first("shipments", { order_id: id }),
    store.list("shipment_tracking", { filters: { order_id: id }, orderBy: { field: "scanned_at", dir: "asc" } }),
    store.list("commission_transactions", { filters: { order_id: id } }),
  ]);

  const netCommission = commission.rows.reduce((s, t) => s + Number(t.amount), 0);

  return ok({
    order: {
      ...order,
      customer_name: (customer as { name: string } | null)?.name ?? "—",
      customer_phone: (customer as { phone: string } | null)?.phone ?? "—",
      customer_email: (customer as { email: string } | null)?.email ?? null,
      worker_name: (worker as { name: string } | null)?.name ?? null,
    },
    items: items.rows,
    history: history.rows,
    shipment: shipment,
    tracking: tracking.rows,
    commission: session.role === "worker" ? { net: netCommission } : { net: netCommission, transactions: commission.rows },
  });
});

const patchSchema = z.object({
  customer_id: z.string().min(1).optional(),
  delivery_address: z.string().optional(),
  city: z.string().optional(),
  notes: z.string().nullable().optional(),
  discount: z.number().nonnegative().optional(),
  cod_amount: z.number().nonnegative().optional(),
  items: z
    .array(
      z.object({
        product_id: z.string().min(1),
        quantity: z.number().positive(),
        unit_price: z.number().nonnegative().optional(),
      })
    )
    .min(1)
    .optional(),
});

/**
 * PATCH /api/orders/[id] — order editing.
 *
 * Admins/super admins: full edit via adminUpdateOrder (server-authoritative):
 * - totals are ALWAYS recomputed from the validated items — no client
 *   subtotal/total is accepted;
 * - closed orders are rejected; booked orders accept notes-only edits
 *   (the Flaship Integration API has no shipment-amendment endpoint —
 *   the honest path for booked orders is cancel + rebook);
 * - stock reservations follow the item diff with upfront availability
 *   validation (no partial reservations);
 * - every edit is written to the audit log.
 *
 * Workers (Phase 6): may correct ONLY the delivery address, city and notes
 * of their OWN unbooked orders — never prices, items, the customer link or
 * the customer master record. Enforced here AND in the service.
 */
const WORKER_EDITABLE_FIELDS = ["delivery_address", "city", "notes"];
const workerPatchSchema = z.object({
  delivery_address: z.string().min(1).optional(),
  city: z.string().min(1).optional(),
  notes: z.string().nullable().optional(),
});

export const PATCH = withAuth(["super_admin", "admin", "worker"], async (session, req, ctx) => {
  try {
    const { id } = await (ctx as unknown as Ctx).params;
    const body = (await req.json()) as Record<string, unknown>;

    if (session.role === "worker") {
      const attempted = Object.keys(body).filter((k) => !WORKER_EDITABLE_FIELDS.includes(k));
      if (attempted.length) {
        return fail("Workers can only edit the delivery address, city and notes of their own orders.", 403);
      }
      const parsed = workerPatchSchema.safeParse(body);
      if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid order data.", 422);
      const order = await workerUpdateOrderDelivery(session, id, parsed.data);
      return ok({ success: true, order });
    }

    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return fail(parsed.error.issues[0]?.message ?? "Invalid order data.", 422);
    }
    const order = await adminUpdateOrder(session, id, parsed.data as AdminOrderUpdateInput);
    return ok({ success: true, order });
  } catch (e) {
    if (e instanceof OrderError) return fail(e.message, 422);
    console.error("[orders.PATCH]", e);
    return fail(GENERIC_ERROR, 500);
  }
});

/**
 * DELETE /api/orders/[id] — permanent removal of a CANCELLED order.
 *
 * Scope guard (production safety):
 * - super_admin ONLY.
 * - Only CANCELLED orders are deletable — booked/delivered/returned history
 *   is never destructible through the API.
 * - Refuses when commission ledger rows reference the order (append-only
 *   ledger must stay intact; CANCELLED orders are never credited, so any row
 *   here is an anomaly requiring manual review).
 * - Flaship is NOT contacted: the courier-side booking (if any) is managed
 *   there; this only removes the local record.
 *
 * Cleanup order (FK-safe; see migrations/0001):
 * - whatsapp_message_queue rows (order_id would be SET NULL → delete explicitly)
 * - notifications pointing at the order detail pages (admin + worker links)
 * - the order row itself: order_items, order_status_history, shipments and
 *   shipment_tracking all CASCADE; commission_transactions.order_id and
 *   flaship_logs.order_id are SET NULL and their rows are preserved.
 * - audit_logs rows are immutable and preserved — an order.deleted entry is
 *   written BEFORE the delete with full identification (order number + CN).
 */
export const DELETE = withAuth(["super_admin"], async (session, _req, ctx) => {
  try {
    const { id } = await (ctx as unknown as Ctx).params;
    const order = await store.get<Order>("orders", id);
    if (!order) return fail("Order not found.", 404);
    if (order.status !== "CANCELLED") {
      return fail("Only cancelled orders can be deleted. Cancel the order first.", 422);
    }

    const commission = await store.list("commission_transactions", { filters: { order_id: id } });
    if (commission.rows.length > 0) {
      return fail(
        `This order has ${commission.rows.length} commission ledger row(s) and cannot be deleted. Review the commission ledger first.`,
        422
      );
    }

    // WhatsApp queue rows for this order (test remnants would otherwise linger
    // detached — the FK sets order_id NULL instead of deleting).
    const queue = await store.list("whatsapp_message_queue", { filters: { order_id: id } });
    for (const row of queue.rows) await store.delete("whatsapp_message_queue", row.id);

    // Notifications that link to this order's detail pages (admin + worker).
    let notificationsRemoved = 0;
    for (const link of [`/admin/orders/${id}`, `/worker/orders/${id}`]) {
      const { rows } = await store.list("notifications", { filters: { link } });
      for (const row of rows) {
        await store.delete("notifications", row.id);
        notificationsRemoved += 1;
      }
    }

    const items = await store.list("order_items", { filters: { order_id: id } });
    const shipments = await store.list("shipments", { filters: { order_id: id } });

    // Immutable audit entry written BEFORE the delete (audit_logs preserves
    // entity_id as text — history survives the order row itself).
    await store.insert("audit_logs", {
      user_id: session.userId,
      user_name: session.name,
      action: "order.deleted",
      entity: "orders",
      entity_id: id,
      old_data: {
        order_number: order.order_number,
        tracking_number: order.tracking_number,
        status: order.status,
        booking_status: order.booking_status,
        customer_id: order.customer_id,
        total: order.total,
      },
      new_data: {
        whatsapp_queue_removed: queue.rows.length,
        notifications_removed: notificationsRemoved,
        order_items_cascaded: items.rows.length,
        shipments_cascaded: shipments.rows.length,
      },
    });

    await store.delete("orders", id);

    return ok({
      success: true,
      removed: {
        order: order.order_number,
        tracking_number: order.tracking_number,
        whatsapp_queue_removed: queue.rows.length,
        notifications_removed: notificationsRemoved,
        order_items_cascaded: items.rows.length,
        shipments_cascaded: shipments.rows.length,
      },
    });
  } catch (e) {
    console.error("[orders.DELETE]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
