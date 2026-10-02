import { ok, fail, withAuth } from "@/lib/api/helpers";
import { changeOrderStatus, workerUpdateStatus, OrderError } from "@/lib/services/orders";
import { ORDER_STATUSES, OrderStatus } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withAuth("any", async (session, req, ctx) => {
  try {
    const { id } = await (ctx as unknown as Ctx).params;
    const body = (await req.json()) as { status?: string; note?: string };
    const status = body.status as OrderStatus;
    if (!status || !ORDER_STATUSES.includes(status)) {
      return fail("Invalid status value.", 422);
    }
    if (session.role === "worker") {
      await workerUpdateStatus(session, id, status, body.note);
    } else {
      await changeOrderStatus(session, id, status, body.note);
    }
    return ok({ success: true, status });
  } catch (e) {
    if (e instanceof OrderError) return fail(e.message, 422);
    console.error("[orders.status]", e);
    return fail("Could not update the order status.", 500);
  }
});
