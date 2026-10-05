import { ok, withAuth, GENERIC_ERROR } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import { getWhatsAppBotSettings } from "@/lib/services/whatsapp";
import type { WhatsAppAccount, WhatsAppQueueItem } from "@/lib/types";

const BOT_OFFLINE_AFTER_MS = 90 * 1000; // heartbeat every ~15s

/**
 * GET /api/whatsapp/overview — dashboard summary for the WhatsApp page header:
 * which numbers are connected, bot online state, queue health at a glance.
 */
export const GET = withAuth(["super_admin", "admin"], async () => {
  try {
    const { rows: accounts } = await store.list<WhatsAppAccount>("whatsapp_accounts", {
      orderBy: { field: "created_at", dir: "asc" },
      perPage: 100,
    });
    const bot = await getWhatsAppBotSettings();

    const counts = { pending: 0, processing: 0, retrying: 0, failed: 0, sent: 0, cancelled: 0 };
    const statuses = ["pending", "processing", "retrying", "failed", "sent", "cancelled"];
    for (const status of statuses) {
      counts[status as keyof typeof counts] = await store.count("whatsapp_message_queue", { status });
    }

    const lastSeen = bot?.last_bot_seen_at ? new Date(bot.last_bot_seen_at).getTime() : 0;
    const botOnline = lastSeen > 0 && Date.now() - lastSeen < BOT_OFFLINE_AFTER_MS;

    // latest failure reason for the header hint (if any)
    const { rows: lastFailed } = await store.list<WhatsAppQueueItem>("whatsapp_message_queue", {
      filters: { status: "failed" },
      orderBy: { field: "updated_at", dir: "desc" },
      perPage: 1,
    });

    return ok({
      accounts: {
        total: accounts.length,
        connected: accounts.filter((a) => a.status === "connected").length,
        connecting: accounts.filter((a) => a.status === "connecting").length,
        enabled: accounts.filter((a) => a.enabled).length,
      },
      counts,
      paused: bot?.paused ?? false,
      failover_enabled: bot?.failover_enabled ?? false,
      bot_online: botOnline,
      bot_last_seen_at: bot?.last_bot_seen_at ?? null,
      last_failure: lastFailed[0]
        ? {
            order_number: lastFailed[0].order_number,
            type: lastFailed[0].notification_type,
            reason: lastFailed[0].failure_reason,
          }
        : null,
    });
  } catch (e) {
    console.error("[whatsapp.overview]", e);
    return ok({
      accounts: { total: 0, connected: 0, connecting: 0, enabled: 0 },
      counts: { pending: 0, processing: 0, retrying: 0, failed: 0, sent: 0, cancelled: 0 },
      paused: false,
      failover_enabled: false,
      bot_online: false,
      bot_last_seen_at: null,
      last_failure: null,
    });
  }
});
