import { ok, fail, withAuth, GENERIC_ERROR } from "@/lib/api/helpers";
import { store, IS_DEMO_MODE } from "@/lib/store";
import { logAudit } from "@/lib/services/audit";
import { hashPassword } from "@/lib/auth/passwords";
import type { Session } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = withAuth(["super_admin", "admin"], async (session: Session, req, ctx) => {
  try {
    const { id } = await (ctx as unknown as Ctx).params;
    const body = (await req.json()) as {
      role?: string; status?: string; name?: string; phone?: string;
      commission_rate?: number; password?: string; team_id?: string | null;
    };
    const user = await store.get("profiles", id);
    if (!user) return fail("User not found.", 404);

    // only super_admin can change roles or edit other admins
    if (body.role && session.role !== "super_admin") {
      return fail("Only a Super Admin can change roles.", 403);
    }
    const targetRole = (user as unknown as { role: string }).role;
    if (targetRole !== "worker" && session.role !== "super_admin" && (user as { id: string }).id !== session.userId) {
      return fail("Only a Super Admin can edit admin accounts.", 403);
    }
    if (id === session.userId && body.status === "disabled") {
      return fail("You cannot disable your own account.", 422);
    }

    const updates: Record<string, unknown> = {};
    if (body.role) updates.role = body.role;
    if (body.status && ["active", "disabled"].includes(body.status)) updates.status = body.status;
    if (body.name?.trim()) updates.name = body.name.trim();
    if (typeof body.phone === "string") updates.phone = body.phone;
    if (typeof body.commission_rate === "number") updates.commission_rate = Math.min(100, Math.max(0, body.commission_rate));
    if (typeof body.team_id !== "undefined") updates.team_id = body.team_id || null;
    if (body.password) {
      if (body.password.length < 6) return fail("Password must be at least 6 characters.", 422);
      if (!IS_DEMO_MODE) {
        return fail("Password changes in live mode must be done through Supabase Auth admin APIs.", 422);
      }
      updates.password_hash = hashPassword(body.password);
    }
    if (Object.keys(updates).length === 0) return fail("Nothing to update.", 422);

    await store.update("profiles", id, updates);
    await logAudit({ session, action: "user.updated", entity: "profiles", entityId: id, oldData: { role: targetRole, status: (user as unknown as { status: string }).status }, newData: updates });
    return ok({ success: true });
  } catch (e) {
    console.error("[users.PATCH]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
