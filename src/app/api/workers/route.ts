import { ok, fail, withAuth, parseListParams, GENERIC_ERROR, sanitizeProfile } from "@/lib/api/helpers";
import { store, IS_DEMO_MODE } from "@/lib/store";
import { z } from "zod";
import { isValidEmail, isValidPhone } from "@/lib/utils";
import { logAudit } from "@/lib/services/audit";
import { hashPassword } from "@/lib/auth/passwords";
import { workerEarnings } from "@/lib/services/commission";
import type { Profile } from "@/lib/types";

export const GET = withAuth(["super_admin", "admin"], async (_session, req) => {
  const url = new URL(req.url);
  const opts = parseListParams(url, "created_at", ["name", "email", "worker_code", "phone"]);
  opts.filters = { ...opts.filters, role: "worker" };
  const { rows, total } = await store.list<Profile>("profiles", opts);
  const { rows: teams } = await store.list<{ id: string; name: string }>("teams");
  const teamMap = new Map(teams.map((t) => [t.id, t.name]));
  const { rows: orders } = await store.list<{ worker_id: string | null; status: string }>("orders");
  const enriched = await Promise.all(
    rows.map(async (w) => {
      const earnings = await workerEarnings(w.id);
      const own = orders.filter((o) => o.worker_id === w.id);
      return sanitizeProfile({
        ...w,
        team_name: w.team_id ? (teamMap.get(w.team_id) ?? null) : null,
        total_orders: own.length,
        delivered_orders: own.filter((o) => o.status === "DELIVERED").length,
        returned_orders: own.filter((o) => o.status === "RETURNED").length,
        ...earnings,
      });
    })
  );
  return ok({ rows: enriched, total, page: opts.page, perPage: opts.perPage });
});

export const POST = withAuth(["super_admin", "admin"], async (session, req) => {
  try {
    const schema = z.object({
      name: z.string().min(1, "Name is required."),
      email: z.string().refine(isValidEmail, "A valid email is required."),
      phone: z.string().refine(isValidPhone, "A valid phone number is required."),
      password: z.string().min(6, "Password must be at least 6 characters."),
      commission_rate: z.number().min(0).max(100, "Commission rate must be between 0 and 100."),
      team_id: z.string().optional().nullable(),
    });
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid data.", 422);
    const dup = await store.first("profiles", { email: parsed.data.email.toLowerCase() });
    if (dup) return fail("A user with this email already exists.", 409);

    const { rows: workers } = await store.list<{ worker_code: string | null }>("profiles", { filters: { role: "worker" } });
    const max = workers.reduce((m, w) => {
      const n = parseInt((w.worker_code ?? "").replace(/\D/g, ""), 10);
      return isNaN(n) ? m : Math.max(m, n);
    }, 0);

    let userId: string;
    if (IS_DEMO_MODE) {
      const user = await store.insert("profiles", {
        email: parsed.data.email.toLowerCase(),
        name: parsed.data.name,
        phone: parsed.data.phone,
        role: "worker",
        worker_code: `W-${String(max + 1).padStart(4, "0")}`,
        commission_rate: parsed.data.commission_rate,
        team_id: parsed.data.team_id || null,
        status: "active",
        password_hash: hashPassword(parsed.data.password),
      });
      userId = user.id;
    } else {
      // Supabase mode: create the auth user with the service role client
      const { getServiceRoleClient } = await import("@/lib/supabase/server");
      const admin = getServiceRoleClient();
      if (!admin) return fail("Server is missing SUPABASE_SERVICE_ROLE_KEY for user creation.", 500);
      const { data, error } = await admin.auth.admin.createUser({
        email: parsed.data.email.toLowerCase(),
        password: parsed.data.password,
        email_confirm: true,
        user_metadata: { name: parsed.data.name, phone: parsed.data.phone },
      });
      if (error || !data.user) return fail(error?.message ?? "Could not create the user.", 422);
      const { error: upErr } = await admin
        .from("profiles")
        .update({
          name: parsed.data.name,
          phone: parsed.data.phone,
          role: "worker",
          worker_code: `W-${String(max + 1).padStart(4, "0")}`,
          commission_rate: parsed.data.commission_rate,
          team_id: parsed.data.team_id || null,
          status: "active",
        })
        .eq("id", data.user.id);
      if (upErr) return fail(upErr.message, 500);
      userId = data.user.id;
    }

    await logAudit({ session, action: "user.created", entity: "profiles", entityId: userId, newData: { email: parsed.data.email, role: "worker" } });
    return ok({ id: userId }, 201);
  } catch (e) {
    console.error("[workers.POST]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
