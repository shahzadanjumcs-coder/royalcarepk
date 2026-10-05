import { ok, withAuth, parseListParams } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import type { WhatsAppMessageLog } from "@/lib/types";

/** GET /api/whatsapp/logs — per-attempt delivery history (?f_queue_id=… to expand one message). */
export const GET = withAuth(["super_admin", "admin"], async (_session, req) => {
  const url = new URL(req.url);
  const opts = parseListParams(url, "created_at", ["error"]);
  const res = await store.list<WhatsAppMessageLog>("whatsapp_message_logs", opts);
  return ok(res);
});
