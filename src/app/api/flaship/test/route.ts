import { ok, withAuth } from "@/lib/api/helpers";
import { testFlashipConnection } from "@/lib/flaship/service";

/**
 * POST /api/flaship/test — admin "Test connection" button (Settings → Flaship API).
 *
 * Runs a server-side connectivity/credentials check against the Flaship
 * Integration API (or reports simulator mode when no key is configured).
 * testFlashipConnection() never throws — failures are returned as
 * { ok: false, message } so the UI shows the REAL Flaship error (including
 * DRF field-level bodies) instead of a generic failure.
 */
export const POST = withAuth(["super_admin", "admin"], async () => {
  const result = await testFlashipConnection();
  return ok(result);
});
