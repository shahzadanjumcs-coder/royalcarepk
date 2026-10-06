import { ok, fail, withAuth, GENERIC_ERROR } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import type { WhatsAppCommand, WhatsAppGroupSetting } from "@/lib/types";

const JID_RE = /^[0-9]{10,25}(-[0-9]+)?@g\.us$/;

/** GET /api/whatsapp/groups — configured Flaship WhatsApp groups. */
export const GET = withAuth(["super_admin", "admin"], async () => {
  const { rows } = await store.list<WhatsAppGroupSetting>("whatsapp_group_settings", {
    orderBy: { field: "created_at", dir: "asc" },
    perPage: 50,
  });
  return ok({ rows });
});

/**
 * POST /api/whatsapp/groups
 *  - {label, group_jid, account_id?}   → save a group (SHIPPER ADVISE target)
 *  - {action: "list_groups", account_id} → ask the bot for joined groups;
 *    poll /api/whatsapp/commands/[id] for the JSON result.
 */
export const POST = withAuth(["super_admin", "admin"], async (_session, req) => {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      label?: string;
      group_jid?: string;
      account_id?: string | null;
    };

    if (body.action === "list_groups") {
      if (!body.account_id) return fail("Select the WhatsApp account that is a member of the group.", 422);
      const cmd = await store.insert<WhatsAppCommand>("whatsapp_commands", {
        account_id: body.account_id,
        command: "list_groups",
        payload: { account_id: body.account_id },
        status: "pending",
      });
      return ok({ command_id: cmd.id, message: "Asked the bot for its joined groups — results appear in a few seconds." }, 201);
    }

    const label = String(body.label ?? "").trim() || "Flaship Group";
    const jid = String(body.group_jid ?? "").trim().toLowerCase();
    if (!JID_RE.test(jid)) {
      return fail('Invalid group identifier. Use the WhatsApp group JID, e.g. "12036302…-1555…@g.us" (use "Fetch groups from bot" to pick one).', 422);
    }
    const dupe = await store.first("whatsapp_group_settings", { group_jid: jid });
    if (dupe) return fail("This group is already configured.", 409);
    const row = await store.insert<WhatsAppGroupSetting>("whatsapp_group_settings", {
      label,
      group_jid: jid,
      account_id: body.account_id ?? null,
      enabled: true,
    });
    return ok({ group: row }, 201);
  } catch (e) {
    console.error("[whatsapp.groups.create]", e);
    return fail(GENERIC_ERROR, 500);
  }
});

/** PATCH /api/whatsapp/groups — {id, label?, account_id?, enabled?} */
export const PATCH = withAuth(["super_admin", "admin"], async (_session, req) => {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      id?: string;
      label?: string;
      account_id?: string | null;
      enabled?: boolean;
    };
    if (!body.id) return fail("Group id is required.", 422);
    const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.label !== undefined) payload.label = String(body.label).trim() || "Flaship Group";
    if (body.account_id !== undefined) payload.account_id = body.account_id;
    if (body.enabled !== undefined) payload.enabled = !!body.enabled;
    const row = await store.update<WhatsAppGroupSetting>("whatsapp_group_settings", body.id, payload);
    return ok({ group: row });
  } catch (e) {
    console.error("[whatsapp.groups.patch]", e);
    return fail(GENERIC_ERROR, 500);
  }
});

/** DELETE /api/whatsapp/groups?id=… */
export const DELETE = withAuth(["super_admin", "admin"], async (_session, req) => {
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return fail("Group id is required.", 422);
    await store.delete("whatsapp_group_settings", id);
    return ok({ ok: true });
  } catch (e) {
    console.error("[whatsapp.groups.delete]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
