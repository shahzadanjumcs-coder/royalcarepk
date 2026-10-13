import { ok, fail, withAuth, GENERIC_ERROR } from "@/lib/api/helpers";
import { getDealWithItems, updateDeal, deleteDeal, DealError, type DealInput } from "@/lib/services/deals";
import { z } from "zod";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withAuth(["super_admin", "admin", "inventory_manager"], async (_session, _req, ctx) => {
  const { id } = await (ctx as unknown as Ctx).params;
  const deal = await getDealWithItems(id);
  if (!deal) return fail("Deal not found.", 404);
  return ok({ deal });
});

const patchSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  selling_price: z.number().nonnegative().optional(),
  status: z.enum(["active", "inactive", "archived"]).optional(),
  items: z
    .array(
      z.object({
        product_id: z.string().min(1),
        quantity: z.number().positive(),
      })
    )
    .min(1)
    .optional(),
});

export const PATCH = withAuth(["super_admin", "admin"], async (session, req, ctx) => {
  try {
    const { id } = await (ctx as unknown as Ctx).params;
    const parsed = patchSchema.safeParse(await req.json());
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid deal data.", 422);
    const deal = await updateDeal(session, id, parsed.data as Partial<DealInput>);
    return ok({ success: true, deal });
  } catch (e) {
    if (e instanceof DealError) return fail(e.message, 422);
    console.error("[deals.PATCH]", e);
    return fail(GENERIC_ERROR, 500);
  }
});

/**
 * DELETE — hard-deletes a deal only when no order ever used it; a used deal
 * is archived instead (order lines keep their snapshots either way).
 */
export const DELETE = withAuth(["super_admin", "admin"], async (session, _req, ctx) => {
  try {
    const { id } = await (ctx as unknown as Ctx).params;
    const result = await deleteDeal(session, id);
    return ok({
      success: true,
      ...result,
      message: result.deleted ? "Deal deleted." : "Deal is referenced by orders and was archived instead of deleted.",
    });
  } catch (e) {
    if (e instanceof DealError) return fail(e.message, 422);
    console.error("[deals.DELETE]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
