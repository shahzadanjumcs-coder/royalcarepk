import { ok, fail, withAuth } from "@/lib/api/helpers";
import { syncOrderTracking, FlashipError } from "@/lib/flaship/service";

type Ctx = { params: Promise<{ id: string }> };

// Admin-only (matches book/approve/assign siblings and the only UI call sites:
// admin/flaship/tracking + admin/orders/[id]). Tracking sync cascades status,
// inventory and COMMISSION changes, so it must never be reachable without an
// admin role — and there is no per-worker ownership check inside
// syncOrderTracking to scope it safely for workers.
export const POST = withAuth(["super_admin", "admin"], async (session, _req, ctx) => {
  try {
    const { id } = await (ctx as unknown as Ctx).params;
    const result = await syncOrderTracking(session, id);
    return ok(result);
  } catch (e) {
    if (e instanceof FlashipError) return fail(e.message, 422);
    console.error("[orders.sync]", e);
    return fail("Tracking sync failed. Please retry.", 500);
  }
});
