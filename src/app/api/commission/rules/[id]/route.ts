import { ok, fail, withAuth, GENERIC_ERROR, pickFields } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import { logAudit } from "@/lib/services/audit";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = withAuth(["super_admin", "admin"], async (session, req, ctx) => {
  try {
    const { id } = await (ctx as unknown as Ctx).params;
    const body = pickFields((await req.json()) as Record<string, unknown>, ["name", "worker_id", "scope", "rate", "status", "note"]);
    const rule = await store.get("commission_rules", id);
    if (!rule) return fail("Rule not found.", 404);
    await store.update("commission_rules", id, body);
    await logAudit({ session, action: "commission.rule_updated", entity: "commission_rules", entityId: id, oldData: rule as Record<string, unknown>, newData: body });
    return ok({ success: true });
  } catch (e) {
    console.error("[commission.rules.PATCH]", e);
    return fail(GENERIC_ERROR, 500);
  }
});

export const DELETE = withAuth(["super_admin", "admin"], async (session, _req, ctx) => {
  try {
    const { id } = await (ctx as unknown as Ctx).params;
    await store.delete("commission_rules", id);
    await logAudit({ session, action: "commission.rule_deleted", entity: "commission_rules", entityId: id });
    return ok({ success: true });
  } catch (e) {
    console.error("[commission.rules.DELETE]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
