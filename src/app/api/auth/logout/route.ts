import { logout } from "@/lib/auth/service";
import { ok } from "@/lib/api/helpers";

export async function POST() {
  await logout();
  return ok({ success: true });
}
