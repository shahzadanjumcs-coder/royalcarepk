import { ok, fail, withAuth, GENERIC_ERROR } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import { z } from "zod";
import { logAudit } from "@/lib/services/audit";

export const GET = withAuth(["super_admin", "admin", "inventory_manager"], async () => {
  const { rows: teams } = await store.list("teams", { orderBy: { field: "created_at", dir: "asc" } });
  const { rows: members } = await store.list<{ id: string; team_id: string; user_id: string; role_in_team: string }>("team_members");
  const { rows: profiles } = await store.list<{ id: string; name: string }>("profiles");
  const pMap = new Map(profiles.map((p) => [p.id, p.name]));
  const enriched = (teams as Record<string, unknown>[]).map((t) => ({
    ...t,
    member_count: members.filter((m) => m.team_id === t.id).length,
    leader_name: t.leader_id ? (pMap.get(t.leader_id as string) ?? null) : null,
  }));
  return ok({ rows: enriched, total: enriched.length });
});

export const POST = withAuth(["super_admin", "admin"], async (session, req) => {
  try {
    const schema = z.object({ name: z.string().min(1, "Team name is required."), description: z.string().optional() });
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid data.", 422);
    const dup = await store.first("teams", { name: parsed.data.name });
    if (dup) return fail("A team with this name already exists.", 409);
    const team = await store.insert("teams", { name: parsed.data.name, description: parsed.data.description || null, status: "active" });
    await logAudit({ session, action: "team.created", entity: "teams", entityId: team.id, newData: { name: team.name } });
    return ok({ team }, 201);
  } catch (e) {
    console.error("[teams.POST]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
