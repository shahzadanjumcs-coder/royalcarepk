import { ok, fail, withAuth, GENERIC_ERROR, pickFields } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import { logAudit } from "@/lib/services/audit";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = withAuth(["super_admin", "admin"], async (session, req, ctx) => {
  try {
    const { id } = await (ctx as unknown as Ctx).params;
    const body = pickFields((await req.json()) as Record<string, unknown>, ["name", "description", "leader_id", "status"]);
    const team = await store.get("teams", id);
    if (!team) return fail("Team not found.", 404);
    await store.update("teams", id, body);
    await logAudit({ session, action: "team.updated", entity: "teams", entityId: id, newData: body });
    return ok({ success: true });
  } catch (e) {
    console.error("[teams.PATCH]", e);
    return fail(GENERIC_ERROR, 500);
  }
});

export const DELETE = withAuth(["super_admin", "admin"], async (session, _req, ctx) => {
  try {
    const { id } = await (ctx as unknown as Ctx).params;
    // detach members first to preserve referential sanity
    const { rows: members } = await store.list("profiles", { filters: { team_id: id } });
    for (const m of members) await store.update("profiles", m.id as string, { team_id: null });
    const { rows: tm } = await store.list("team_members", { filters: { team_id: id } });
    for (const m of tm) await store.delete("team_members", m.id as string);
    await store.delete("teams", id);
    await logAudit({ session, action: "team.deleted", entity: "teams", entityId: id });
    return ok({ success: true });
  } catch (e) {
    console.error("[teams.DELETE]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
