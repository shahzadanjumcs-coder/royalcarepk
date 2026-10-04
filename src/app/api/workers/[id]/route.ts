import { ok, fail, withAuth, GENERIC_ERROR } from "@/lib/api/helpers";
import { store, IS_DEMO_MODE } from "@/lib/store";
import { getWorkerDetail, deleteWorkerAccount, WorkerDeleteError } from "@/lib/services/workers";
import { logAudit } from "@/lib/services/audit";
import { isValidPercent } from "@/lib/utils";
import type { Session } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withAuth(["super_admin", "admin"], async (_session, _req, ctx) => {
  const { id } = await (ctx as unknown as Ctx).params;
  const detail = await getWorkerDetail(id);
  if (!detail) return fail("Worker not found.", 404);
  return ok({ worker: detail });
});

export const PATCH = withAuth(["super_admin", "admin"], async (session: Session, req, ctx) => {
  try {
    const { id } = await (ctx as unknown as Ctx).params;
    const body = (await req.json()) as Record<string, unknown>;
    const worker = await store.get("profiles", id);
    if (!worker) return fail("Worker not found.", 404);
    if ((worker as unknown as { role: string }).role !== "worker") return fail("This user is not a worker.", 422);

    const updates: Record<string, unknown> = {};
    if (typeof body.name === "string" && body.name.trim()) updates.name = body.name.trim();
    if (typeof body.phone === "string") updates.phone = body.phone;
    if (typeof body.team_id !== "undefined") updates.team_id = body.team_id || null;
    if (typeof body.status === "string" && ["active", "disabled"].includes(body.status)) updates.status = body.status;
    if (typeof body.commission_rate !== "undefined") {
      const rate = Number(body.commission_rate);
      if (!isValidPercent(rate)) return fail("Commission rate must be between 0 and 100.", 422);
      updates.commission_rate = rate;
    }
    if (Object.keys(updates).length === 0) return fail("Nothing to update.", 422);

    await store.update("profiles", id, updates);
    await logAudit({
      session, action: "user.updated", entity: "profiles", entityId: id,
      oldData: worker as Record<string, unknown>, newData: updates,
    });
    return ok({ success: true });
  } catch (e) {
    console.error("[workers.PATCH]", e);
    return fail(GENERIC_ERROR, 500);
  }
});

/**
 * Permanently delete a worker account (super_admin only).
 * Historical orders, order items, payments, commissions, shipments and audit
 * logs are NEVER deleted — worker references are nulled and identity snapshots
 * preserved (migration 0003). The login account is removed server-side via the
 * service-role admin API so the worker can no longer sign in.
 */
export const DELETE = withAuth(["super_admin"], async (session: Session, _req, ctx) => {
  try {
    const { id } = await (ctx as unknown as Ctx).params;
    const result = await deleteWorkerAccount(session, id);
    return ok({ success: true, deleted: result });
  } catch (e) {
    if (e instanceof WorkerDeleteError) return fail(e.message, 422);
    console.error("[workers.DELETE]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
