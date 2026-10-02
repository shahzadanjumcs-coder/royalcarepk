import { ok, fail, withAuth, GENERIC_ERROR } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import { z } from "zod";
import { logAudit } from "@/lib/services/audit";

export const GET = withAuth(["super_admin", "admin"], async () => {
  const { rows } = await store.list("team_members", { orderBy: { field: "joined_at", dir: "desc" } });
  const { rows: profiles } = await store.list<{ id: string; name: string; worker_code: string | null; role: string }>("profiles", { filters: { role: "worker" } });
  const { rows: teams } = await store.list<{ id: string; name: string }>("teams");
  const pMap = new Map(profiles.map((p) => [p.id, p]));
  const tMap = new Map(teams.map((t) => [t.id, t.name]));
  const enriched = (rows as Record<string, unknown>[]).map((m) => {
    const p = pMap.get(m.user_id as string);
    return { ...m, user_name: p?.name ?? "—", worker_code: p?.worker_code ?? null, team_name: tMap.get(m.team_id as string) ?? "—" };
  });
  return ok({ rows: enriched, total: enriched.length });
});

export const POST = withAuth(["super_admin", "admin"], async (session, req) => {
  try {
    const schema = z.object({
      user_id: z.string().min(1, "Select a worker."),
      team_id: z.string().min(1, "Select a team."),
      role_in_team: z.string().default("Rider"),
    });
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid data.", 422);
    const dup = await store.first("team_members", { user_id: parsed.data.user_id, team_id: parsed.data.team_id });
    if (dup) return fail("This worker is already in that team.", 409);
    const member = await store.insert("team_members", {
      user_id: parsed.data.user_id,
      team_id: parsed.data.team_id,
      role_in_team: parsed.data.role_in_team || "Rider",
      joined_at: new Date().toISOString(),
    });
    // keep the worker's primary team in sync
    await store.update("profiles", parsed.data.user_id, { team_id: parsed.data.team_id });
    await logAudit({ session, action: "assignment.created", entity: "team_members", entityId: member.id, newData: parsed.data });
    return ok({ member }, 201);
  } catch (e) {
    console.error("[assignments.POST]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
