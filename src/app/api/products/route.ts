import { ok, fail, withAuth, parseListParams, GENERIC_ERROR } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import { z } from "zod";
import { logAudit } from "@/lib/services/audit";
import type { Product } from "@/lib/types";

// Staff-only: rows include COST data (purchase_price, stock_value). The worker
// order form must use /api/lookup, whose worker branch strips cost fields.
export const GET = withAuth(["super_admin", "admin", "inventory_manager"], async (_session, req) => {
  const url = new URL(req.url);
  const opts = parseListParams(url, "created_at", ["name", "sku", "barcode"]);
  const { rows, total } = await store.list<Product>("products", opts);
  const { rows: cats } = await store.list<{ id: string; name: string }>("categories");
  const { rows: sups } = await store.list<{ id: string; name: string }>("suppliers");
  const cMap = new Map(cats.map((c) => [c.id, c.name]));
  const sMap = new Map(sups.map((s) => [s.id, s.name]));
  const enriched = rows.map((p) => ({
    ...p,
    category_name: p.category_id ? (cMap.get(p.category_id) ?? null) : null,
    supplier_name: p.supplier_id ? (sMap.get(p.supplier_id) ?? null) : null,
    available_stock: p.current_stock - p.reserved_stock,
    stock_value: p.current_stock * p.purchase_price,
  }));
  return ok({ rows: enriched, total, page: opts.page, perPage: opts.perPage });
});

export const POST = withAuth(["super_admin", "admin", "inventory_manager"], async (session, req) => {
  try {
    const schema = z.object({
      name: z.string().min(1, "Product name is required."),
      sku: z.string().min(2, "SKU is required."),
      barcode: z.string().optional().nullable(),
      category_id: z.string().optional().nullable(),
      supplier_id: z.string().optional().nullable(),
      purchase_price: z.number().nonnegative("Purchase price must be zero or more."),
      selling_price: z.number().positive("Selling price must be greater than zero."),
      current_stock: z.number().int().nonnegative().default(0),
      min_stock: z.number().int().nonnegative().default(5),
      status: z.enum(["active", "inactive"]).default("active"),
    });
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid data.", 422);
    const dup = await store.first("products", { sku: parsed.data.sku });
    if (dup) return fail("A product with this SKU already exists.", 409);
    const product = await store.insert("products", {
      ...parsed.data,
      reserved_stock: 0,
      barcode: parsed.data.barcode || null,
      category_id: parsed.data.category_id || null,
      supplier_id: parsed.data.supplier_id || null,
    });
    // opening stock movement
    if (parsed.data.current_stock > 0) {
      await store.insert("inventory_movements", {
        product_id: product.id,
        type: "PURCHASE",
        quantity: parsed.data.current_stock,
        reserved_change: 0,
        balance_after: parsed.data.current_stock,
        reserved_after: 0,
        note: "Opening stock",
        created_by: session.userId,
      });
    }
    await logAudit({ session, action: "product.created", entity: "products", entityId: product.id, newData: { name: product.name, sku: product.sku } });
    return ok({ product }, 201);
  } catch (e) {
    console.error("[products.POST]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
