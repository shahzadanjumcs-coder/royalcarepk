import { ok, fail, withAuth, GENERIC_ERROR } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import { isAccountSessionLive } from "@/lib/services/whatsapp";
import type { WhatsAppAccount } from "@/lib/types";

/**
 * GET  /api/whatsapp/accounts  — list all WhatsApp accounts (admin only)
 * POST /api/whatsapp/accounts  — add a new WhatsApp number {name}
 *
 * Session credentials NEVER live here — only metadata. The QR pairing session
 * storage stays on the bot host; this API just registers the account row.
 *
 * Each row carries a server-computed `session_live` flag: DB status says
 * "connected" AND the bot's per-account heartbeat is fresh. A stale row
 * (bot process dead) must never be presented to the admin as connected.
 */
export const GET = withAuth(["super_admin", "admin"], async () => {
  const { rows } = await store.list<WhatsAppAccount>("whatsapp_accounts", {
    orderBy: { field: "created_at", dir: "asc" },
    perPage: 100,
  });
  const nowMs = Date.now();
  return ok({
    rows: rows.map((a) => ({ ...a, session_live: isAccountSessionLive(a, nowMs) })),
  });
});

export const POST = withAuth(["super_admin", "admin"], async (_session, req) => {
  try {
    const body = (await req.json().catch(() => ({}))) as { name?: string };
    const name = String(body.name ?? "").trim();
    if (!name) return fail("Account name is required (e.g. Main WhatsApp).", 422);
    if (name.length > 60) return fail("Account name is too long (max 60 characters).", 422);

    const dupe = await store.first("whatsapp_accounts", { name });
    if (dupe) return fail(`An account named "${name}" already exists.`, 409);

    const { rows } = await store.list("whatsapp_accounts", { perPage: 1 });
    const account = await store.insert<WhatsAppAccount>("whatsapp_accounts", {
      name,
      phone: null,
      status: "disconnected",
      enabled: true,
      // first added account becomes the default sending account
      is_default: rows.length === 0,
      qr_code: null,
      qr_updated_at: null,
      last_connected_at: null,
      last_disconnected_at: null,
      last_error: null,
      last_seen_at: null,
    });
    return ok({ account }, 201);
  } catch (e) {
    if (e instanceof Error && /duplicate/i.test(e.message)) {
      return fail("An account with this name already exists.", 409);
    }
    console.error("[whatsapp.accounts.create]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
