import { ok, fail, withAuth, GENERIC_ERROR } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import type { Order } from "@/lib/types";

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

export const PATCH = withAuth(["super_admin", "admin"], async (session, req, ctx) => {
  try {
    const { id } = await (ctx as unknown as Ctx).params;
    const body = (await req.json()) as Partial<{ delivery_address: string; city: string; notes: string; cod_amount: number }>;
    const order = await store.get<Order>("orders", id);
    if (!order) return fail("Order not found.", 404);
    if (["DELIVERED", "RETURNED", "CANCELLED"].includes(order.status)) {
      return fail("Closed orders cannot be edited.", 422);
    }
    await store.update("orders", id, {
      delivery_address: body.delivery_address ?? order.delivery_address,
      city: body.city ?? order.city,
      notes: body.notes ?? order.notes,
      cod_amount: body.cod_amount ?? order.cod_amount,
    });
    await store.insert("audit_logs", {
      user_id: session.userId, user_name: session.name, action: "order.updated",
      entity: "orders", entity_id: id, old_data: { status: order.status }, new_data: body as Record<string, unknown>,
    });
    return ok({ success: true });
  } catch (e) {
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
