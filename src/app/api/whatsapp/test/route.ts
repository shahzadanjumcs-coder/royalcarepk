import { ok, fail, withAuth, GENERIC_ERROR } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import { normalizePkWhatsApp, getWhatsAppBotSettings, isBotOnline, isAccountSessionLive } from "@/lib/services/whatsapp";

/** Same sanity rule the bot applies to group JIDs (bot/src/lib.js). */
const GROUP_JID_RE = /^[0-9]{10,25}(-[0-9]+)?@g\.us$/;

type TestBody = {
  kind?: "message" | "group";
  account_id?: string;
  phone?: string;
  group_jid?: string;
  message?: string;
};

/**
 * POST /api/whatsapp/test — queue a clearly-labelled test send.
 *
 * Mirrors the account-action pattern: the admin panel inserts a command row,
 * the always-on bot claims it, sends via the connected session, and the panel
 * polls the command result. Nothing here talks to WhatsApp directly.
 *
 * The bot heartbeat is checked BEFORE queueing: an offline bot would leave
 * the command pending forever and look like a success that never arrives.
 * In that case the test is refused with an explicit "Bot is offline" instead
 * of pretending the message will be sent. Real order notifications are NOT
 * blocked by this — they are an outbox and queue safely while offline.
 */
export const POST = withAuth(["super_admin", "admin"], async (_session, req) => {
  try {
    const body = (await req.json().catch(() => ({}))) as TestBody;
    const kind = body.kind === "group" ? "group" : "message";
    const accountId = String(body.account_id ?? "").trim();
    const message = String(body.message ?? "").trim();

    if (!accountId) return fail("Select a WhatsApp account first.", 422);
    if (!message) return fail("Write a test message first.", 422);
    if (message.length > 3000) return fail("Test message is too long (max 3000 characters).", 422);

    const bot = await getWhatsAppBotSettings();
    if (!isBotOnline(bot)) {
      return fail(
        "Bot is offline — start the WhatsApp bot service on your always-on machine, then retry. The test was NOT queued.",
        503
      );
    }

    const account = await store.get<{ id: string; name: string; enabled: boolean; status: string; last_seen_at: string | null }>(
      "whatsapp_accounts",
      accountId
    );
    if (!account) return fail("WhatsApp account not found.", 404);
    if (!account.enabled) return fail("Enable this account before sending tests through it.", 422);
    if (!isAccountSessionLive(account)) {
      return fail(
        account.status === "connected"
          ? `"${account.name}" shows connected but the bot has not reported its session recently — check the bot service, then reconnect the account.`
          : `"${account.name}" is not connected — connect it first.`,
        422
      );
    }

    if (kind === "group") {
      const jid = String(body.group_jid ?? "").trim();
      if (!GROUP_JID_RE.test(jid)) return fail("Enter a valid group JID (e.g. 120363…-…@g.us).", 422);
      const row = await store.insert("whatsapp_commands", {
        account_id: accountId,
        command: "test_group",
        payload: { account_id: accountId, group_jid: jid, message },
        status: "pending",
      });
      return ok({ command_id: row.id, message: "Test queued — the bot will send it to the group shortly." });
    }

    const normalized = normalizePkWhatsApp(body.phone ?? null);
    if (!normalized.valid) return fail(normalized.reason ?? "Enter a valid WhatsApp number.", 422);
    const row = await store.insert("whatsapp_commands", {
      account_id: accountId,
      command: "test_message",
      payload: { account_id: accountId, phone: normalized.digits, message },
      status: "pending",
    });
    return ok({ command_id: row.id, message: "Test queued — the bot will send it shortly." });
  } catch (e) {
    console.error("[whatsapp.test]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
