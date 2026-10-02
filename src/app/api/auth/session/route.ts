import { getSession } from "@/lib/auth/session";
import { ok } from "@/lib/api/helpers";
import { IS_DEMO_MODE } from "@/lib/store";

export async function GET() {
  const session = await getSession();
  return ok({ session, mode: IS_DEMO_MODE ? "demo" : "supabase" });
}
