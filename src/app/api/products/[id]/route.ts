import { ok, fail, withAuth, GENERIC_ERROR } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import { logAudit } from "@/lib/services/audit";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withAuth(["super_admin", "admin", "inventory_manager"], async (_session, _req, ctx) => {
  const { id } = await (ctx as unknown as Ctx).params;
  const product = await store.get("products", id);
  if (!product) return fail("Product not found.", 404);
  const { rows: movements } = await store.list("inventory_movements", {
    filters: { product_id: id },
    orderBy: { field: "created_at", dir: "desc" },
  });
  return ok({ product, movements });
});

export const PATCH = withAuth(["super_admin", "admin", "inventory_manager"], async (session, req, ctx) => {
  try {
    const { id } = await (ctx as unknown as Ctx).params;
    const body = (await req.json()) as Record<string, unknown>;
    const product = await store.get("products", id);
    if (!product) return fail("Product not found.", 404);
    if (typeof body.sku === "string" && body.sku !== product.sku) {
      const dup = await store.first("products", { sku: body.sku });
      if (dup) return fail("A product with this SKU already exists.", 409);
    }
    // stock is only changed via movements — strip direct stock edits
    delete body.current_stock;
    delete body.reserved_stock;
    await store.update("products", id, { ...body, updated_at: new Date().toISOString() });
    await logAudit({ session, action: "product.updated", entity: "products", entityId: id, oldData: product as Record<string, unknown>, newData: body });
    return ok({ success: true });
  } catch (e) {
    console.error("[products.PATCH]", e);
    return fail(GENERIC_ERROR, 500);
  }
});

export const DELETE = withAuth(["super_admin", "admin"], async (session, _req, ctx) => {
  try {
    const { id } = await (ctx as unknown as Ctx).params;
    const product = await store.get("products", id);
    if (!product) return fail("Product not found.", 404);
    // Deletion safety — check EVERY relationship a product delete touches at
    // the database level before allowing a hard delete:
    //   - order_items.product_id       ON DELETE SET NULL   (0001_init.sql)
    //   - inventory_movements.product_id ON DELETE CASCADE  (0001_init.sql)
    //   - deal_items.product_id        ON DELETE CASCADE    (0009_deals.sql)
    // The inventory movement ledger is append-only business history and the
    // components of live deals must never silently vanish, so any of these
    // references forces a soft-disable instead of a destructive delete.
    const [orderRefs, dealRefs, movementRefs] = await Promise.all([
      store.count("order_items", { product_id: id }),
      store.count("deal_items", { product_id: id }),
      store.count("inventory_movements", { product_id: id }),
    ]);
    const reasons: string[] = [];
    if (orderRefs > 0) reasons.push("order history");
    if (dealRefs > 0) reasons.push("deal membership");
    if (movementRefs > 0) reasons.push("inventory movement history");
    if (reasons.length > 0) {
      await store.update("products", id, { status: "inactive" });
      await logAudit({ session, action: "product.disabled", entity: "products", entityId: id });
      const reasonText =
        reasons.length === 1
          ? reasons[0]
          : `${reasons.slice(0, -1).join(", ")} and ${reasons[reasons.length - 1]}`;
      return ok({
        success: true,
        disabled: true,
        message: `Product has ${reasonText} and was deactivated instead of deleted. Deletion is blocked to protect sales history, deal bundles, and the inventory ledger — re-enable the product from the products list if it should sell again.`,
      });
    }
    await store.delete("products", id);
    await logAudit({ session, action: "product.deleted", entity: "products", entityId: id });
    return ok({ success: true });
  } catch (e) {
    console.error("[products.DELETE]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
