import { requestPasswordReset, AuthError } from "@/lib/auth/service";
import { ok, fail } from "@/lib/api/helpers";

export async function POST(req: Request) {
  try {
    const { email } = (await req.json()) as { email?: string };
    if (!email) return fail("Email is required.", 422);
    const message = await requestPasswordReset(email);
    return ok({ message });
  } catch (e) {
    if (e instanceof AuthError) return fail(e.message, 400);
    console.error("[forgot-password]", e);
    return fail("Unable to process the request right now.", 500);
  }
}
