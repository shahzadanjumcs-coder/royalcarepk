import { ok, fail, withAuth, GENERIC_ERROR } from "@/lib/api/helpers";
import { applyMovement, InventoryError } from "@/lib/services/inventory";
import { notifyAdmins } from "@/lib/services/notifications";
import { logAudit } from "@/lib/services/audit";
import { z } from "zod";
import { store } from "@/lib/store";

const schema = z.object({
  product_id: z.string().min(1, "Select a product."),
  type: z.enum(["STOCK_IN", "STOCK_OUT", "ADJUSTMENT", "RETURN", "PURCHASE"]),
  quantity: z.number().int().refine((n) => n !== 0, "Quantity cannot be zero."),
  note: z.string().optional().nullable(),
});

export const POST = withAuth(["super_admin", "admin", "inventory_manager"], async (session, req) => {
  try {
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid data.", 422);
    const { product_id, type, quantity, note } = parsed.data;

    if ((type === "STOCK_IN" || type === "PURCHASE" || type === "RETURN") && quantity <= 0) {
      return fail("Quantity must be a positive number for this operation.", 422);
    }
    if (type === "STOCK_OUT" && quantity >= 0) {
      return fail("Enter the amount going out as a negative number, or use Stock In.", 422);
    }

    await applyMovement({
      productId: product_id,
      type,
      quantity,
      note: note || (type === "PURCHASE" ? "Purchase received" : null),
      userId: session.userId,
    });

    const product = await store.get<{ name: string; current_stock: number; min_stock: number }>("products", product_id);
    if (product && product.current_stock <= product.min_stock) {
      await notifyAdmins({
        title: "Low stock alert",
        message: `${product.name} is at ${product.current_stock} units (minimum: ${product.min_stock}).`,
        type: "warning",
        link: "/admin/inventory",
      });
    }

    await logAudit({
      session, action: `inventory.${type.toLowerCase()}`, entity: "products", entityId: product_id,
      newData: { type, quantity, note: note ?? null },
    });
    return ok({ success: true }, 201);
  } catch (e) {
    if (e instanceof InventoryError) return fail(e.message, 422);
    console.error("[inventory.movement]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
