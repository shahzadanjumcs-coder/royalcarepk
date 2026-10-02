import { NextResponse } from "next/server";
import { login, AuthError } from "@/lib/auth/service";
import { ok, fail } from "@/lib/api/helpers";
import { logAudit } from "@/lib/services/audit";
import { IS_DEMO_MODE } from "@/lib/store";
import { getSession } from "@/lib/auth/session";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { email?: string; password?: string };
    if (!body.email || !body.password) return fail("Email and password are required.", 422);
    if (body.password.length < 6) return fail("Password must be at least 6 characters.", 422);
    const result = await login(body.email, body.password);
    const session = await getSession();
    await logAudit({ session, action: "auth.login", entity: "auth", entityId: session?.userId ?? null });
    return ok({ ...result, mode: IS_DEMO_MODE ? "demo" : "supabase" });
  } catch (e) {
    if (e instanceof AuthError) return fail(e.message, 401);
    console.error("[login]", e);
    return fail("Unable to sign in right now. Please try again.", 500);
  }
}
