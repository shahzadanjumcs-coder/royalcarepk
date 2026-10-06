import { ok, fail, withAuth, GENERIC_ERROR, pickFields } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import { logAudit } from "@/lib/services/audit";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = withAuth(["super_admin", "admin", "inventory_manager"], async (session, req, ctx) => {
  try {
    const { id } = await (ctx as unknown as Ctx).params;
    const body = pickFields((await req.json()) as Record<string, unknown>, ["name", "description", "status"]);
    const cat = await store.get("categories", id);
    if (!cat) return fail("Category not found.", 404);
    await store.update("categories", id, body);
    await logAudit({ session, action: "category.updated", entity: "categories", entityId: id, newData: body });
    return ok({ success: true });
  } catch (e) {
    console.error("[categories.PATCH]", e);
    return fail(GENERIC_ERROR, 500);
  }
});

export const DELETE = withAuth(["super_admin", "admin"], async (session, _req, ctx) => {
  try {
    const { id } = await (ctx as unknown as Ctx).params;
    const total = await store.count("products", { category_id: id });
    if (total > 0) return fail("Cannot delete: this category still has products. Move them first.", 422);
    await store.delete("categories", id);
    await logAudit({ session, action: "category.deleted", entity: "categories", entityId: id });
    return ok({ success: true });
  } catch (e) {
    console.error("[categories.DELETE]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
