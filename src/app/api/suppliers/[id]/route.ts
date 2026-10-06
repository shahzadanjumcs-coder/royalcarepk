import { ok, fail, withAuth, GENERIC_ERROR, pickFields } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import { logAudit } from "@/lib/services/audit";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = withAuth(["super_admin", "admin", "inventory_manager"], async (session, req, ctx) => {
  try {
    const { id } = await (ctx as unknown as Ctx).params;
    const body = pickFields((await req.json()) as Record<string, unknown>, ["name", "contact_person", "phone", "email", "address", "status"]);
    const sup = await store.get("suppliers", id);
    if (!sup) return fail("Supplier not found.", 404);
    await store.update("suppliers", id, body);
    await logAudit({ session, action: "supplier.updated", entity: "suppliers", entityId: id, newData: body });
    return ok({ success: true });
  } catch (e) {
    console.error("[suppliers.PATCH]", e);
    return fail(GENERIC_ERROR, 500);
  }
});

export const DELETE = withAuth(["super_admin", "admin"], async (session, _req, ctx) => {
  try {
    const { id } = await (ctx as unknown as Ctx).params;
    const total = await store.count("products", { supplier_id: id });
    if (total > 0) return fail("Cannot delete: this supplier still has products assigned.", 422);
    await store.delete("suppliers", id);
    await logAudit({ session, action: "supplier.deleted", entity: "suppliers", entityId: id });
    return ok({ success: true });
  } catch (e) {
    console.error("[suppliers.DELETE]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
