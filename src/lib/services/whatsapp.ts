import "server-only";
import { store } from "@/lib/store";
import type { Order } from "@/lib/types";
import {
  WHATSAPP_TYPE_RECIPIENT_KIND,
  type WhatsAppBotSettings,
  type WhatsAppNotificationType,
  type WhatsAppRoutingSetting,
} from "@/lib/types";

/**
 * WhatsApp notification service — server-side only.
 *
 * DESIGN RULES (mirrors notify()/logAudit() — never breaks the caller):
 *  - enqueueWhatsAppOrderEvent() NEVER throws and NEVER blocks the order flow.
 *    If the WhatsApp layer is misconfigured or the bot is offline, messages stay
 *    safely queued in whatsapp_message_queue for later processing.
 *  - Idempotency: every queue row carries a UNIQUE dedupe_key
 *    ({order_id}:{type}:{recipient}). A re-processed event can never create a
 *    second notification. The unique index is authoritative in Supabase; a
 *    pre-check also covers the demo memory store (which has no constraints).
 *  - Phone numbers are normalized to WhatsApp JID digits (92XXXXXXXXXX) before
 *    enqueue so identical customers with different formats dedupe to one key.
 *  - No secrets and no session data ever touch this module — sessions live only
 *    on the bot host (whatsapp-bot/), accounts metadata lives in Supabase.
 */

export class WhatsAppConfigError extends Error {}

// --------------------------------------------------------------- templates --

/** Defaults mirror migration 0004 seeds — used when a routing row is missing. */
export const DEFAULT_TEMPLATES: Record<WhatsAppNotificationType, string> = {
  BOOKED:
    "Assalam-o-Alaikum {{customer_name}},\nYour order {{order_number}} has been booked successfully.\nCourier: {{courier}}\nTracking/CN: {{cn_number}}\nThank you for choosing RoyalCarePK.",
  OUT_FOR_DELIVERY:
    "Assalam-o-Alaikum {{customer_name}},\nYour order {{order_number}} is out for delivery today.\nTracking/CN: {{cn_number}}\nPlease keep your phone available for the rider.",
  DELIVERED:
    "Assalam-o-Alaikum {{customer_name}},\nYour order {{order_number}} has been delivered successfully.\nThank you for choosing RoyalCarePK.",
  RETURNED:
    "RoyalCarePK Alert\nOrder {{order_number}} has been returned.\nCustomer: {{customer_name}}\nCN: {{cn_number}}\nReason: {{return_reason}}",
  SHIPPER_ADVISE:
    "RoyalCarePK / Flaship Update\nOrder: {{order_number}}\nCustomer: {{customer_name}}\nCN: {{cn_number}}\nStatus: SHIPPER ADVISE\nReason: {{reason}}",
};

/**
 * Render a template by simple {{var}} substitution. Values are plain strings —
 * there is NO code evaluation path, so templates cannot execute anything.
 * Unknown placeholders are left visible on purpose (admin immediately sees a typo).
 */
export function renderTemplate(template: string, vars: Record<string, string | number | null | undefined>): string {
  return String(template ?? "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? match : String(value);
  });
}

// ------------------------------------------------------------------ phones --

export interface NormalizedPhone {
  valid: boolean;
  /** digits only, e.g. 923001234567 — this is the WhatsApp identity */
  digits: string;
  reason?: string;
}

/**
 * Normalize Pakistani WhatsApp numbers safely:
 *   03XXXXXXXXX | +923XXXXXXXXX | 923XXXXXXXXX | 00923XXXXXXXXX -> 923XXXXXXXXX
 * Dashes/spaces/brackets are ignored. A generic 10-15 digit international
 * number is passed through as-is so foreign customers still work.
 */
export function normalizePkWhatsApp(phone: string | null | undefined): NormalizedPhone {
  const raw = String(phone ?? "");
  let cleaned = raw.replace(/[^0-9+]/g, "");
  if (cleaned.startsWith("+")) cleaned = cleaned.slice(1);
  if (cleaned.startsWith("00")) cleaned = cleaned.slice(2);

  if (cleaned.startsWith("92")) {
    const rest = cleaned.slice(2);
    if (rest.length === 10 && rest.startsWith("3")) {
      return { valid: true, digits: `92${rest}` };
    }
    // 92 + 03... (duplicate leading zero after country code) — tolerate
    if (rest.length === 11 && rest.startsWith("03")) {
      return { valid: true, digits: `92${rest.slice(1)}` };
    }
    return { valid: false, digits: cleaned, reason: "Not a valid Pakistani mobile number (expected 92 3XXXXXXXXX)." };
  }

  // any 0-prefixed number must be a full Pakistani mobile (03XXXXXXXXX, 11 digits)
  if (cleaned.startsWith("0")) {
    if (cleaned.length === 11 && cleaned.startsWith("03")) {
      return { valid: true, digits: `92${cleaned.slice(1)}` };
    }
    return {
      valid: false,
      digits: cleaned,
      reason: "Pakistani mobile numbers have 11 digits starting with 03 (e.g. 03001234567).",
    };
  }

  // generic international fallback (non-PK): 10..15 digits
  if (cleaned.length >= 10 && cleaned.length <= 15) {
    return { valid: true, digits: cleaned };
  }

  return { valid: false, digits: cleaned, reason: "Missing or invalid WhatsApp number." };
}

/** Build the WhatsApp chat JID from normalized digits. */
export function toWhatsAppJid(digits: string, kind: "customer" | "admin" | "group" = "customer"): string {
  if (kind === "group" || digits.includes("@")) return digits; // group JID passes through
  return `${digits}@s.whatsapp.net`;
}

// ------------------------------------------------------------ dedupe keys ---

export function buildDedupeKey(orderId: string, type: WhatsAppNotificationType, recipient: string): string {
  return `${orderId}:${type}:${recipient}`;
}

// ------------------------------------------------------------- bot settings -

export async function getWhatsAppBotSettings(): Promise<WhatsAppBotSettings | null> {
  return store.first<WhatsAppBotSettings>("whatsapp_bot_settings", {});
}

export async function getRoutingRow(type: WhatsAppNotificationType): Promise<WhatsAppRoutingSetting | null> {
  return store.first<WhatsAppRoutingSetting>("whatsapp_routing_settings", { notification_type: type });
}

// ----------------------------------------------------------------- enqueue --

interface QueueInsert {
  order_id: string | null;
  order_number: string | null;
  notification_type: WhatsAppNotificationType;
  recipient: string;
  recipient_kind: "customer" | "admin" | "group";
  message: string;
  max_retries: number;
  dedupe_key: string;
  status?: "pending" | "failed";
  failure_reason?: string;
}

/** Insert one queue row; silently skip when the dedupe key already exists. */
async function enqueueRow(row: QueueInsert): Promise<void> {
  const existing = await store.first("whatsapp_message_queue", { dedupe_key: row.dedupe_key });
  if (existing) return; // idempotent — event already recorded
  try {
    await store.insert("whatsapp_message_queue", {
      order_id: row.order_id,
      order_number: row.order_number,
      notification_type: row.notification_type,
      recipient: row.recipient,
      recipient_kind: row.recipient_kind,
      message: row.message,
      status: row.status ?? "pending",
      max_retries: row.max_retries,
      failure_reason: row.failure_reason ?? null,
      dedupe_key: row.dedupe_key,
    });
  } catch (e) {
    // unique violation (23505) = concurrent duplicate — that is success for us
    const message = e instanceof Error ? e.message : "";
    if (!/duplicate key|already exists|23505|unique/i.test(message)) {
      console.error("[whatsapp] queue insert failed:", e);
    }
  }
}

/**
 * Fan out a WhatsApp notification for an order event.
 *
 * Recipients by type (configurable in routing settings):
 *   BOOKED / OUT_FOR_DELIVERY / DELIVERED -> customer phone on the order
 *   RETURNED                              -> every enabled admin recipient
 *   SHIPPER_ADVISE                        -> every enabled Flaship group
 *
 * Failed lookups (missing customer phone, no recipients configured) are stored
 * as FAILED rows with the reason so the admin message log explains itself —
 * and they are still deduped, so they never retry in a loop.
 */
export async function enqueueWhatsAppOrderEvent(params: {
  orderId: string;
  type: WhatsAppNotificationType;
}): Promise<void> {
  try {
    const { orderId, type } = params;
    const kind = WHATSAPP_TYPE_RECIPIENT_KIND[type];

    const order = await store.get<Order>("orders", orderId);
    if (!order) return;

    const routing = await getRoutingRow(type);
    if (routing && !routing.enabled) return; // admin disabled this notification type

    const template = routing?.template ?? DEFAULT_TEMPLATES[type];
    const botSettings = await getWhatsAppBotSettings();
    const maxRetries = botSettings?.max_retries ?? 3;

    // ---- shared template variables (safe, text only) ----
    const customer = await store.get<{ name: string; phone: string }>("customers", order.customer_id);
    const latestTracking = await store.list<{ status: string; description: string | null }>("shipment_tracking", {
      filters: { order_id: orderId },
      orderBy: { field: "scanned_at", dir: "desc" },
      perPage: 1,
    });
    const trackingNote = latestTracking.rows[0]?.description ?? null;
    const vars: Record<string, string> = {
      customer_name: customer?.name ?? "Customer",
      order_number: order.order_number,
      cn_number: order.tracking_number ?? "Pending",
      courier: order.flaship_courier_name ?? "Flaship",
      status: type,
      city: order.city ?? "",
      total: String(order.total ?? ""),
    };

    // ---- resolve recipients per notification kind ----
    if (kind === "customer") {
      const normalized = normalizePkWhatsApp(customer?.phone);
      const key = buildDedupeKey(orderId, type, normalized.valid ? normalized.digits : (customer?.phone || "unknown"));
      if (!normalized.valid) {
        // do NOT retry in a loop — record the failure once for the admin log
        await enqueueRow({
          order_id: orderId,
          order_number: order.order_number,
          notification_type: type,
          recipient: customer?.phone?.trim() || "unknown",
          recipient_kind: kind,
          message: renderTemplate(template, vars),
          max_retries: maxRetries,
          dedupe_key: key,
          status: "failed",
          failure_reason: normalized.reason ?? "Invalid or missing customer WhatsApp number.",
        });
        return;
      }
      await enqueueRow({
        order_id: orderId,
        order_number: order.order_number,
        notification_type: type,
        recipient: normalized.digits,
        recipient_kind: kind,
        message: renderTemplate(template, vars),
        max_retries: maxRetries,
        dedupe_key: key,
      });
      return;
    }

    if (kind === "admin") {
      const { rows: recipients } = await store.list<{ id: string; phone: string; enabled: boolean }>(
        "whatsapp_admin_recipients",
        { filters: { enabled: true }, perPage: 50 }
      );
      if (!recipients.length) {
        await enqueueRow({
          order_id: orderId,
          order_number: order.order_number,
          notification_type: type,
          recipient: "admin-recipients",
          recipient_kind: kind,
          message: renderTemplate(template, vars),
          max_retries: maxRetries,
          dedupe_key: buildDedupeKey(orderId, type, "admin-recipients"),
          status: "failed",
          failure_reason: "No enabled admin WhatsApp recipient configured (Settings -> Recipients & Groups).",
        });
        return;
      }
      for (const r of recipients) {
        const normalized = normalizePkWhatsApp(r.phone);
        const key = buildDedupeKey(orderId, type, normalized.valid ? normalized.digits : `recipient:${r.id}`);
        if (!normalized.valid) {
          await enqueueRow({
            order_id: orderId,
            order_number: order.order_number,
            notification_type: type,
            recipient: r.phone,
            recipient_kind: kind,
            message: renderTemplate(template, vars),
            max_retries: maxRetries,
            dedupe_key: key,
            status: "failed",
            failure_reason: `Admin recipient "${r.phone}" is not a valid WhatsApp number.`,
          });
          continue;
        }
        await enqueueRow({
          order_id: orderId,
          order_number: order.order_number,
          notification_type: type,
          recipient: normalized.digits,
          recipient_kind: kind,
          message: renderTemplate(template, vars),
          max_retries: maxRetries,
          dedupe_key: key,
        });
      }
      return;
    }

    // kind === "group"
    const { rows: groups } = await store.list<{ id: string; group_jid: string; enabled: boolean }>(
      "whatsapp_group_settings",
      { filters: { enabled: true }, perPage: 20 }
    );
    const reason = trackingNote ?? order.rejection_reason ?? "Not specified";
    const groupVars = { ...vars, reason, return_reason: reason };
    if (!groups.length) {
      await enqueueRow({
        order_id: orderId,
        order_number: order.order_number,
        notification_type: type,
        recipient: "flaship-group",
        recipient_kind: kind,
        message: renderTemplate(template, groupVars),
        max_retries: maxRetries,
        dedupe_key: buildDedupeKey(orderId, type, "flaship-group"),
        status: "failed",
        failure_reason: "No enabled WhatsApp group configured (Settings -> Recipients & Groups).",
      });
      return;
    }
    for (const g of groups) {
      const jid = String(g.group_jid ?? "").trim();
      const okJid = /^[0-9-]+@g\.us$/.test(jid);
      const key = buildDedupeKey(orderId, type, okJid ? jid : `group:${g.id}`);
      if (!okJid) {
        await enqueueRow({
          order_id: orderId,
          order_number: order.order_number,
          notification_type: type,
          recipient: jid || "invalid-group",
          recipient_kind: kind,
          message: renderTemplate(template, groupVars),
          max_retries: maxRetries,
          dedupe_key: key,
          status: "failed",
          failure_reason: `Group JID "${jid}" is invalid (expected 123456789-123456@g.us).`,
        });
        continue;
      }
      await enqueueRow({
        order_id: orderId,
        order_number: order.order_number,
        notification_type: type,
        recipient: jid,
        recipient_kind: kind,
        message: renderTemplate(template, groupVars),
        max_retries: maxRetries,
        dedupe_key: key,
      });
    }
  } catch (e) {
    // NEVER let WhatsApp fan-out break the order flow
    console.error("[whatsapp] enqueueWhatsAppOrderEvent failed:", e);
  }
}
