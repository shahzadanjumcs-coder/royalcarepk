import { ok, fail, withAuth, GENERIC_ERROR } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import { DEFAULT_TEMPLATES, getWhatsAppBotSettings } from "@/lib/services/whatsapp";
import {
  WHATSAPP_NOTIFICATION_TYPES,
  type WhatsAppAccount,
  type WhatsAppBotSettings,
  type WhatsAppNotificationType,
  type WhatsAppRoutingSetting,
} from "@/lib/types";

interface RoutingPatch {
  notification_type: WhatsAppNotificationType;
  account_id?: string | null;
  fallback_account_id?: string | null;
  enabled?: boolean;
  template?: string;
}

interface BotPatch {
  paused?: boolean;
  failover_enabled?: boolean;
  send_delay_ms?: number;
  max_retries?: number;
}

async function readSettings() {
  const { rows: routing } = await store.list<WhatsAppRoutingSetting>("whatsapp_routing_settings", { perPage: 20 });
  // guarantee a row per type even if seeds were never applied
  const merged: WhatsAppRoutingSetting[] = WHATSAPP_NOTIFICATION_TYPES.map((type) => {
    const row = routing.find((r) => r.notification_type === type);
    return (
      row ?? {
        id: `default:${type}`,
        notification_type: type,
        account_id: null,
        fallback_account_id: null,
        enabled: true,
        template: DEFAULT_TEMPLATES[type],
        updated_at: new Date().toISOString(),
      }
    );
  });
  const bot = await getWhatsAppBotSettings();
  const { rows: accounts } = await store.list<WhatsAppAccount>("whatsapp_accounts", {
    orderBy: { field: "created_at", dir: "asc" },
    perPage: 100,
  });
  return ok({ routing: merged, bot, accounts });
}

/**
 * GET   /api/whatsapp/settings — routing rows (+defaults), bot settings, account picker list
 * PATCH /api/whatsapp/settings — {routing: RoutingPatch[]} and/or {bot: BotPatch}
 *
 * Templates are plain-text with {{safe_var}} placeholders — rendered by simple
 * string substitution on the server. There is NO code execution path.
 */
export const GET = withAuth(["super_admin", "admin"], async () => readSettings());

export const PATCH = withAuth(["super_admin", "admin"], async (_session, req) => {
  try {
    const body = (await req.json().catch(() => ({}))) as { routing?: RoutingPatch[]; bot?: BotPatch };
    const now = new Date().toISOString();

    if (Array.isArray(body.routing)) {
      for (const patch of body.routing) {
        if (!WHATSAPP_NOTIFICATION_TYPES.includes(patch.notification_type)) continue;
        const existing = await store.first<WhatsAppRoutingSetting>("whatsapp_routing_settings", {
          notification_type: patch.notification_type,
        });
        const payload = {
          notification_type: patch.notification_type,
          account_id: patch.account_id ?? null,
          fallback_account_id: patch.fallback_account_id ?? null,
          enabled: patch.enabled ?? true,
          template: String(patch.template ?? "").trim() || DEFAULT_TEMPLATES[patch.notification_type],
          updated_at: now,
        };
        if (existing) {
          await store.update("whatsapp_routing_settings", existing.id, payload);
        } else {
          await store.insert("whatsapp_routing_settings", payload);
        }
      }
    }

    if (body.bot) {
      const bot = await getWhatsAppBotSettings();
      const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number(v) || 0)));
      const payload: Record<string, unknown> = { updated_at: now };
      if (body.bot.paused !== undefined) payload.paused = !!body.bot.paused;
      if (body.bot.failover_enabled !== undefined) payload.failover_enabled = !!body.bot.failover_enabled;
      if (body.bot.send_delay_ms !== undefined) payload.send_delay_ms = clamp(body.bot.send_delay_ms, 500, 60000);
      if (body.bot.max_retries !== undefined) payload.max_retries = clamp(body.bot.max_retries, 0, 10);
      if (bot) {
        await store.update("whatsapp_bot_settings", bot.id, payload);
      } else {
        await store.insert("whatsapp_bot_settings", {
          paused: false,
          failover_enabled: false,
          send_delay_ms: 2500,
          max_retries: 3,
          ...payload,
        });
      }
    }

    return await readSettings();
  } catch (e) {
    console.error("[whatsapp.settings.patch]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
