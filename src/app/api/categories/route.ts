import { ok, fail, withAuth, GENERIC_ERROR } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import { z } from "zod";
import { logAudit } from "@/lib/services/audit";
import type { Category } from "@/lib/types";

export const GET = withAuth("any", async () => {
  const { rows, total } = await store.list<Category>("categories", { orderBy: { field: "name", dir: "asc" } });
  const { rows: products } = await store.list<{ category_id: string | null }>("products");
  const enriched = rows.map((c) => ({ ...c, product_count: products.filter((p) => p.category_id === c.id).length }));
  return ok({ rows: enriched, total });
});

export const POST = withAuth(["super_admin", "admin", "inventory_manager"], async (session, req) => {
  try {
    const schema = z.object({ name: z.string().min(1, "Category name is required."), description: z.string().optional() });
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid data.", 422);
    const dup = await store.first("categories", { name: parsed.data.name });
    if (dup) return fail("A category with this name already exists.", 409);
    const category = await store.insert("categories", { name: parsed.data.name, description: parsed.data.description || null, status: "active" });
    await logAudit({ session, action: "category.created", entity: "categories", entityId: category.id, newData: { name: category.name } });
    return ok({ category }, 201);
  } catch (e) {
    console.error("[categories.POST]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
