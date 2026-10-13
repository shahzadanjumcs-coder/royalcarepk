import { ok, fail, withAuth, GENERIC_ERROR } from "@/lib/api/helpers";
import { createDeal, listDealsWithItems, DealError, type DealInput } from "@/lib/services/deals";
import { z } from "zod";

/**
 * Deals / bundles admin API (Phase 5).
 * GET  — staff list with resolved components (workers use /api/lookup).
 * POST — create a deal (admin only).
 */
export const GET = withAuth(["super_admin", "admin", "inventory_manager"], async (_session, req) => {
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const statuses = status
    ? status.split(",").filter((s): s is "active" | "inactive" | "archived" =>
        ["active", "inactive", "archived"].includes(s))
    : undefined;
  const deals = await listDealsWithItems({ statuses });
  return ok({ rows: deals, total: deals.length });
});

const dealSchema = z.object({
  name: z.string().min(1, "Deal name is required."),
  description: z.string().nullable().optional(),
  selling_price: z.number().nonnegative("Selling price cannot be negative."),
  status: z.enum(["active", "inactive", "archived"]).optional(),
  items: z
    .array(
      z.object({
        product_id: z.string().min(1, "Every component needs a product."),
        quantity: z.number().positive("Component quantities must be positive."),
      })
    )
    .min(1, "A deal needs at least one component product."),
});

export const POST = withAuth(["super_admin", "admin"], async (session, req) => {
  try {
    const parsed = dealSchema.safeParse(await req.json());
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid deal data.", 422);
    const deal = await createDeal(session, parsed.data as DealInput);
    return ok({ deal }, 201);
  } catch (e) {
    if (e instanceof DealError) return fail(e.message, 422);
    console.error("[deals.POST]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
