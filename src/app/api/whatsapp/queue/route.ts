import { ok, withAuth, GENERIC_ERROR, parseListParams } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import type { WhatsAppQueueItem } from "@/lib/types";

/**
 * GET /api/whatsapp/queue — message log / queue with filters:
 *   ?status=sent|failed|pending|retrying|processing|cancelled (single)
 *   &f_notification_type=BOOKED &f_recipient_kind=admin
 *   &search=<order number / recipient / message> &from/to &page/perPage
 */
export const GET = withAuth(["super_admin", "admin"], async (_session, req) => {
  try {
    const url = new URL(req.url);
    const opts = parseListParams(url, "created_at", ["order_number", "recipient", "message"]);
    // status can be a comma list (the Messages tab groups these)
    const rawStatus = url.searchParams.get("status");
    if (rawStatus?.includes(",")) {
      const list = rawStatus.split(",").map((s) => s.trim()).filter(Boolean);
      if (list.length) {
        delete (opts.filters as Record<string, unknown>).status;
        opts.inFilters = { ...(opts.inFilters ?? {}), status: list };
      }
    }
    const res = await store.list<WhatsAppQueueItem>("whatsapp_message_queue", opts);
    return ok(res);
  } catch (e) {
    console.error("[whatsapp.queue.list]", e);
    return ok({ rows: [], total: 0, page: 1, perPage: 15 }, 200);
  }
});
