import { ok, fail, withAuth, parseListParams, GENERIC_ERROR, sanitizeProfile } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import { z } from "zod";
import { isValidEmail } from "@/lib/utils";
import { logAudit } from "@/lib/services/audit";
import { hashPassword } from "@/lib/auth/passwords";
import type { Profile, Role } from "@/lib/types";

const VALID_ROLES: Role[] = ["super_admin", "admin", "worker", "inventory_manager"];

export const GET = withAuth(["super_admin", "admin"], async (_session, req) => {
  const url = new URL(req.url);
  const opts = parseListParams(url, "created_at", ["name", "email"]);
  const { rows, total } = await store.list<Profile>("profiles", opts);
  const { rows: teams } = await store.list<{ id: string; name: string }>("teams");
  const tMap = new Map(teams.map((t) => [t.id, t.name]));
  const enriched = rows.map((u) => sanitizeProfile({ ...u, team_name: u.team_id ? (tMap.get(u.team_id) ?? null) : null }));
  return ok({ rows: enriched, total, page: opts.page, perPage: opts.perPage });
});

export const POST = withAuth(["super_admin"], async (session, req) => {
  try {
    const schema = z.object({
      name: z.string().min(1, "Name is required."),
      email: z.string().refine(isValidEmail, "A valid email is required."),
      phone: z.string().optional(),
      password: z.string().min(6, "Password must be at least 6 characters."),
      role: z.enum(["super_admin", "admin", "worker", "inventory_manager"]),
      commission_rate: z.number().min(0).max(100).default(0),
    });
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid data.", 422);
    const dup = await store.first("profiles", { email: parsed.data.email.toLowerCase() });
    if (dup) return fail("A user with this email already exists.", 409);
    const user = await store.insert("profiles", {
      email: parsed.data.email.toLowerCase(),
      name: parsed.data.name,
      phone: parsed.data.phone ?? "",
      role: parsed.data.role,
      worker_code: parsed.data.role === "worker" ? `W-${Date.now().toString().slice(-4)}` : null,
      commission_rate: parsed.data.role === "worker" ? parsed.data.commission_rate : 0,
      status: "active",
      password_hash: hashPassword(parsed.data.password),
    });
    await logAudit({ session, action: "user.created", entity: "profiles", entityId: user.id, newData: { email: user.email, role: user.role } });
    return ok({ id: user.id }, 201);
  } catch (e) {
    console.error("[users.POST]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
