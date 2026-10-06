import { ok, fail, withAuth, GENERIC_ERROR } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import type { WhatsAppAccount } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

type AccountAction =
  | "connect" // start/scan pairing or re-login (bot shows QR when needed)
  | "logout" // unlink the session on WhatsApp (new QR required afterwards)
  | "remove" // delete account row + bot wipes the local session storage
  | "enable"
  | "disable"
  | "set_default";

/**
 * POST /api/whatsapp/accounts/[id] — {action}
 * Device actions (connect/logout/remove) are enqueued as commands that the bot
 * polls and executes; the account row reflects the requested state immediately
 * so the UI is responsive while the bot catches up.
 */
export const POST = withAuth(["super_admin", "admin"], async (_session, req, ctx) => {
  try {
    const { id } = await (ctx as unknown as Ctx).params;
    const body = (await req.json().catch(() => ({}))) as { action?: AccountAction };
    const action = body.action;

    const account = await store.get<WhatsAppAccount>("whatsapp_accounts", id);
    if (!account) return fail("WhatsApp account not found.", 404);

    switch (action) {
      case "connect": {
        if (!account.enabled) return fail("Enable this account before connecting it.", 422);
        await store.insert("whatsapp_commands", {
          account_id: id,
          command: "connect",
          payload: { account_id: id },
          status: "pending",
        });
        await store.update("whatsapp_accounts", id, {
          status: "connecting",
          last_error: null,
          updated_at: new Date().toISOString(),
        });
        return ok({ ok: true, message: "Connect request sent to the bot. Scan the QR code when it appears." });
      }
      case "logout": {
        await store.insert("whatsapp_commands", {
          account_id: id,
          command: "logout",
          payload: { account_id: id },
          status: "pending",
        });
        await store.update("whatsapp_accounts", id, {
          status: "disconnected",
          qr_code: null,
          qr_updated_at: null,
          last_disconnected_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        return ok({ ok: true, message: "Logout request sent to the bot. A new QR scan will be required to connect again." });
      }
      case "remove":
      case undefined: {
        // Command first (bot cleans the local session files), then drop the row.
        // commands.account_id is ON DELETE SET NULL and the payload keeps the id,
        // so the bot can still clean up after the row is gone.
        await store.insert("whatsapp_commands", {
          account_id: id,
          command: "remove",
          payload: { account_id: id },
          status: "pending",
        });
        await store.delete("whatsapp_accounts", id);
        return ok({ ok: true, message: "Account removed. The bot will wipe its isolated session files." });
      }
      case "enable":
      case "disable": {
        const enabled = action === "enable";
        await store.update("whatsapp_accounts", id, {
          enabled,
          ...(enabled ? {} : { status: "disconnected", qr_code: null, qr_updated_at: null }),
          updated_at: new Date().toISOString(),
        });
        return ok({ ok: true, message: enabled ? "Account enabled." : "Account disabled." });
      }
      case "set_default": {
        const { rows } = await store.list<WhatsAppAccount>("whatsapp_accounts", { perPage: 100 });
        for (const row of rows) {
          if (row.is_default) {
            await store.update("whatsapp_accounts", row.id, { is_default: false, updated_at: new Date().toISOString() });
          }
        }
        await store.update("whatsapp_accounts", id, { is_default: true, enabled: true, updated_at: new Date().toISOString() });
        return ok({ ok: true, message: `"${account.name}" is now the default sending account.` });
      }
      default:
        return fail("Unknown action.", 422);
    }
  } catch (e) {
    console.error("[whatsapp.accounts.action]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
