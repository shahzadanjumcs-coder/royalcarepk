import { signup, AuthError } from "@/lib/auth/service";
import { ok, fail } from "@/lib/api/helpers";
import { isValidEmail } from "@/lib/utils";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { name?: string; email?: string; phone?: string; password?: string };
    if (!body.name?.trim()) return fail("Full name is required.", 422);
    if (!body.email || !isValidEmail(body.email)) return fail("A valid email is required.", 422);
    if (!body.password || body.password.length < 6) return fail("Password must be at least 6 characters.", 422);
    const result = await signup({
      name: body.name,
      email: body.email,
      phone: body.phone,
      password: body.password,
    });
    return ok(result);
  } catch (e) {
    if (e instanceof AuthError) return fail(e.message, 400);
    console.error("[signup]", e);
    return fail("Unable to create the account right now.", 500);
  }
}
