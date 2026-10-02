import { ok, fail, withAuth } from "@/lib/api/helpers";
import { assignWorker, OrderError } from "@/lib/services/orders";
import { z } from "zod";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withAuth(["super_admin", "admin"], async (session, req, ctx) => {
  try {
    const { id } = await (ctx as unknown as Ctx).params;
    const parsed = z.object({ worker_id: z.string().min(1) }).safeParse(await req.json());
    if (!parsed.success) return fail("A valid worker must be selected.", 422);
    await assignWorker(session, id, parsed.data.worker_id);
    return ok({ success: true });
  } catch (e) {
    if (e instanceof OrderError) return fail(e.message, 422);
    console.error("[orders.assign]", e);
    return fail("Could not assign the worker.", 500);
  }
});
