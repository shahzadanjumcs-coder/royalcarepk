import { ok, fail, withAuth, GENERIC_ERROR, pickFields } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import { logAudit } from "@/lib/services/audit";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withAuth(["super_admin", "admin", "inventory_manager"], async (_session, _req, ctx) => {
  const { id } = await (ctx as unknown as Ctx).params;
  const customer = await store.get("customers", id);
  if (!customer) return fail("Customer not found.", 404);
  const { rows: orders } = await store.list("orders", {
    filters: { customer_id: id },
    orderBy: { field: "created_at", dir: "desc" },
  });
  const delivered = orders.filter((o) => o.status === "DELIVERED");
  return ok({
    customer,
    stats: {
      total_orders: orders.length,
      delivered_orders: delivered.length,
      returned_orders: orders.filter((o) => o.status === "RETURNED").length,
      total_spending: delivered.reduce((s, o) => s + Number(o.total), 0),
    },
    orders,
  });
});

export const PATCH = withAuth(["super_admin", "admin"], async (session, req, ctx) => {
  try {
    const { id } = await (ctx as unknown as Ctx).params;
    const body = pickFields((await req.json()) as Record<string, unknown>, ["name", "phone", "email", "address", "city", "status", "notes"]);
    const existing = await store.get("customers", id);
    if (!existing) return fail("Customer not found.", 404);
    await store.update("customers", id, body);
    await logAudit({ session, action: "customer.updated", entity: "customers", entityId: id, oldData: existing as Record<string, unknown>, newData: body });
    return ok({ success: true });
  } catch (e) {
    console.error("[customers.PATCH]", e);
    return fail(GENERIC_ERROR, 500);
  }
});

export const DELETE = withAuth(["super_admin", "admin"], async (session, _req, ctx) => {
  try {
    const { id } = await (ctx as unknown as Ctx).params;
    const total = await store.count("orders", { customer_id: id });
    if (total > 0) {
      // soft-disable instead of deleting — preserves order history integrity
      await store.update("customers", id, { status: "disabled" });
      await logAudit({ session, action: "customer.disabled", entity: "customers", entityId: id });
      return ok({ success: true, disabled: true, message: "Customer has existing orders and was disabled instead of deleted." });
    }
    await store.delete("customers", id);
    await logAudit({ session, action: "customer.deleted", entity: "customers", entityId: id });
    return ok({ success: true });
  } catch (e) {
    console.error("[customers.DELETE]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
