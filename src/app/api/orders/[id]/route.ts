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
