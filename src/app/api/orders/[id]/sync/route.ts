import { ok, fail, withAuth } from "@/lib/api/helpers";
import { syncOrderTracking, FlashipError } from "@/lib/flaship/service";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withAuth("any", async (session, _req, ctx) => {
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
