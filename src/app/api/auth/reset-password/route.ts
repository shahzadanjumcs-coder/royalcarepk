import { resetPassword, AuthError } from "@/lib/auth/service";
import { ok, fail } from "@/lib/api/helpers";

export async function POST(req: Request) {
  try {
    const { email, password } = (await req.json()) as { email?: string; password?: string };
    if (!email) return fail("Email is required.", 422);
    if (!password || password.length < 6) return fail("Password must be at least 6 characters.", 422);
    await resetPassword(email, password);
    return ok({ message: "Password updated. You can now sign in." });
  } catch (e) {
    if (e instanceof AuthError) return fail(e.message, 400);
    console.error("[reset-password]", e);
    return fail("Unable to reset the password right now.", 500);
  }
}
