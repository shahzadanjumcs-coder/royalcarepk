import { ok, fail, withAuth, GENERIC_ERROR } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import type { WhatsAppQueueItem } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/whatsapp/queue/[id] — {action: "retry" | "cancel"}
 *
 * Retry: explicit admin action for a FAILED message — re-queues it once more
 * (retry_count is reset, reason cleared). Never happens automatically after
 * max_retries was reached, so there is no infinite retry loop.
 * Cancel: stops a pending/retrying message from ever being sent.
 */
export const POST = withAuth(["super_admin", "admin"], async (_session, req, ctx) => {
  try {
    const { id } = await (ctx as unknown as Ctx).params;
    const body = (await req.json().catch(() => ({}))) as { action?: "retry" | "cancel" };
    const row = await store.get<WhatsAppQueueItem>("whatsapp_message_queue", id);
    if (!row) return fail("Message not found.", 404);

    if (body.action === "retry") {
      if (row.status !== "failed") {
        return fail("Only failed messages can be retried.", 422);
      }
      const updated = await store.update<WhatsAppQueueItem>("whatsapp_message_queue", id, {
        status: "pending",
        retry_count: 0,
        failure_reason: null,
        next_attempt_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      return ok({ item: updated, message: "Message re-queued. The bot will pick it up on its next pass." });
    }

    if (body.action === "cancel") {
      if (["sent", "cancelled"].includes(row.status)) {
        return fail(`A ${row.status} message cannot be cancelled.`, 422);
      }
      const updated = await store.update<WhatsAppQueueItem>("whatsapp_message_queue", id, {
        status: "cancelled",
        updated_at: new Date().toISOString(),
      });
      return ok({ item: updated, message: "Message cancelled." });
    }

    return fail("Unknown action.", 422);
  } catch (e) {
    console.error("[whatsapp.queue.action]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
