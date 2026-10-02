import { ok, fail, withAuth, GENERIC_ERROR } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import { logAudit } from "@/lib/services/audit";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = withAuth(["super_admin", "admin"], async (session, _req, ctx) => {
  try {
    const { id } = await (ctx as unknown as Ctx).params;
    const member = await store.get("team_members", id);
    if (!member) return fail("Assignment not found.", 404);
    await store.delete("team_members", id);
    // clear primary team if it pointed at this team
    const profile = await store.get<{ team_id: string | null }>("profiles", member.user_id as string);
    if (profile?.team_id === member.team_id) {
      await store.update("profiles", member.user_id as string, { team_id: null });
    }
    await logAudit({ session, action: "assignment.removed", entity: "team_members", entityId: id });
    return ok({ success: true });
  } catch (e) {
    console.error("[assignments.DELETE]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
