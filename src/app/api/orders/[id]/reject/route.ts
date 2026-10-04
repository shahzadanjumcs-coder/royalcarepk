import { ok, fail, withAuth, GENERIC_ERROR } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import { rejectOrder, OrderError } from "@/lib/services/orders";
import type { Order } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Reject a worker-submitted order. Admin/super_admin only; a rejection reason
 * is mandatory (422 without one). The worker is notified with the reason and
 * the stock reservation is released via the existing status engine.
 */
export const POST = withAuth(["super_admin", "admin"], async (session, req, ctx) => {
  const { id } = await (ctx as unknown as Ctx).params;
  try {
    const body = (await req.json().catch(() => ({}))) as { reason?: string };
    const reason = (body.reason ?? "").trim();
    if (!reason) {
      return fail("A rejection reason is required.", 422);
    }
    const order = await rejectOrder(session, id, reason);
    // re-read so the response reflects the post-rejection state (CANCELLED status)
    const fresh = await store.get<Order>("orders", id);
    return ok({ order: fresh ?? order });
  } catch (e) {
    if (e instanceof OrderError) return fail(e.message, 422);
    console.error("[orders.reject]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
