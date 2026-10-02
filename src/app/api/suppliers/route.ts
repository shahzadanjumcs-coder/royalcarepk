import { ok, fail, withAuth, GENERIC_ERROR } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import { z } from "zod";
import { isValidEmail } from "@/lib/utils";
import { logAudit } from "@/lib/services/audit";
import type { Supplier } from "@/lib/types";

export const GET = withAuth(["super_admin", "admin", "inventory_manager"], async () => {
  const { rows, total } = await store.list<Supplier>("suppliers", { orderBy: { field: "name", dir: "asc" } });
  const { rows: products } = await store.list<{ supplier_id: string | null }>("products");
  const enriched = rows.map((s) => ({ ...s, product_count: products.filter((p) => p.supplier_id === s.id).length }));
  return ok({ rows: enriched, total });
});

export const POST = withAuth(["super_admin", "admin", "inventory_manager"], async (session, req) => {
  try {
    const schema = z.object({
      name: z.string().min(1, "Supplier name is required."),
      contact_person: z.string().optional().nullable(),
      phone: z.string().optional().nullable(),
      email: z.string().refine((v) => !v || isValidEmail(v), "Invalid email.").optional().nullable(),
      address: z.string().optional().nullable(),
    });
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid data.", 422);
    const dup = await store.first("suppliers", { name: parsed.data.name });
    if (dup) return fail("A supplier with this name already exists.", 409);
    const supplier = await store.insert("suppliers", { ...parsed.data, status: "active" });
    await logAudit({ session, action: "supplier.created", entity: "suppliers", entityId: supplier.id, newData: { name: supplier.name } });
    return ok({ supplier }, 201);
  } catch (e) {
    console.error("[suppliers.POST]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
