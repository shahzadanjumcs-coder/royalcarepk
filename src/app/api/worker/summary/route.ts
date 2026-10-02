import { ok, fail, withAuth } from "@/lib/api/helpers";
import { getWorkerDetail } from "@/lib/services/workers";
import { store } from "@/lib/store";
import type { Session } from "@/lib/types";

/** Worker's own dashboard data — scoped to the session user, never anyone else's. */
export const GET = withAuth("any", async (session: Session) => {
  if (session.role !== "worker") return fail("This endpoint is for workers.", 403);
  const detail = await getWorkerDetail(session.userId);
  if (!detail) return fail("Profile not found.", 404);
  // workers should not see internal staffing fields
  const today = new Date().toISOString().slice(0, 10);
  const todayOrders = detail.recent_orders.filter((o) => o.created_at.slice(0, 10) === today).length;
  return ok({
    worker: {
      ...detail,
      performance: { ...detail.performance, today_orders: todayOrders },
    },
  });
});
