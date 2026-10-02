import { ok, fail, withAuth, GENERIC_ERROR } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import { z } from "zod";
import { logAudit } from "@/lib/services/audit";

export const GET = withAuth(["super_admin", "admin"], async () => {
  const { rows } = await store.list("commission_rules", { orderBy: { field: "created_at", dir: "asc" } });
  const { rows: workers } = await store.list<{ id: string; name: string }>("profiles", { filters: { role: "worker" } });
  const wMap = new Map(workers.map((w) => [w.id, w.name]));
  const enriched = (rows as Record<string, unknown>[]).map((r) => ({
    ...r,
    worker_name: r.worker_id ? (wMap.get(r.worker_id as string) ?? null) : null,
  }));
  return ok({ rows: enriched, total: enriched.length });
});

export const POST = withAuth(["super_admin", "admin"], async (session, req) => {
  try {
    const schema = z.object({
      name: z.string().min(1, "Rule name is required."),
      scope: z.enum(["default", "worker"]),
      worker_id: z.string().optional().nullable(),
      rate: z.number().min(0, "Rate cannot be negative.").max(100, "Rate cannot exceed 100%."),
      note: z.string().optional(),
    });
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid data.", 422);
    if (parsed.data.scope === "worker" && !parsed.data.worker_id) {
      return fail("Select a worker for worker-specific rules.", 422);
    }
    const rule = await store.insert("commission_rules", {
      name: parsed.data.name,
      scope: parsed.data.scope,
      worker_id: parsed.data.scope === "worker" ? parsed.data.worker_id : null,
      rate: parsed.data.rate,
      status: "active",
      note: parsed.data.note || null,
    });
    await logAudit({ session, action: "commission.rule_created", entity: "commission_rules", entityId: rule.id, newData: parsed.data as unknown as Record<string, unknown> });
    return ok({ rule }, 201);
  } catch (e) {
    console.error("[commission.rules.POST]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
