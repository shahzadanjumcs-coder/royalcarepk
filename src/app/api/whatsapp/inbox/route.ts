import { ok, withAuth, parseListParams } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import type { WhatsAppInboxItem } from "@/lib/types";

/**
 * GET /api/whatsapp/inbox — incoming WhatsApp messages captured by the local
 * bot via Baileys `messages.upsert` (status broadcasts, own outgoing echoes
 * and protocol noise are excluded by the bot).
 *
 * Filters: ?search=<phone / name / text> &f_chat_kind=direct|group &page/perPage
 */
export const GET = withAuth(["super_admin", "admin"], async (_session, req) => {
  const url = new URL(req.url);
  const opts = parseListParams(url, "created_at", ["sender_phone", "sender_name", "body", "chat_jid"]);
  const res = await store.list<WhatsAppInboxItem>("whatsapp_inbox", opts);
  return ok(res);
});
