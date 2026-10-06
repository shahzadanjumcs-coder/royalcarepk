"use strict";
/**
 * RoyalCarePK WhatsApp bot — pure helper functions (no I/O).
 * Keep this file dependency-free so unit tests run anywhere.
 */

/**
 * Normalize Pakistani WhatsApp numbers safely:
 *   03XXXXXXXXX | +923XXXXXXXXX | 923XXXXXXXXX | 00923XXXXXXXXX -> 923XXXXXXXXX
 * Generic international numbers (10..15 digits) pass through as-is.
 * Mirrors src/lib/services/whatsapp.ts in the main app — keep both in sync.
 */
function normalizePkWhatsApp(phone) {
  let cleaned = String(phone ?? "").replace(/[^0-9+]/g, "");
  if (cleaned.startsWith("+")) cleaned = cleaned.slice(1);
  if (cleaned.startsWith("00")) cleaned = cleaned.slice(2);

  if (cleaned.startsWith("92")) {
    const rest = cleaned.slice(2);
    if (rest.length === 10 && rest.startsWith("3")) return { valid: true, digits: "92" + rest };
    if (rest.length === 11 && rest.startsWith("03")) return { valid: true, digits: "92" + rest.slice(1) };
    return { valid: false, digits: cleaned, reason: "Not a valid Pakistani mobile number (expected 92 3XXXXXXXXX)." };
  }
  // any 0-prefixed number must be a full Pakistani mobile (03XXXXXXXXX, 11 digits)
  if (cleaned.startsWith("0")) {
    if (cleaned.length === 11 && cleaned.startsWith("03")) return { valid: true, digits: "92" + cleaned.slice(1) };
    return {
      valid: false,
      digits: cleaned,
      reason: "Pakistani mobile numbers have 11 digits starting with 03 (e.g. 03001234567).",
    };
  }
  if (cleaned.length >= 10 && cleaned.length <= 15) {
    return { valid: true, digits: cleaned };
  }
  return { valid: false, digits: cleaned, reason: "Missing or invalid WhatsApp number." };
}

/** Chat JID for a normalized number or a group JID passthrough. */
function toJid(recipient, kind) {
  if (kind === "group" || String(recipient).includes("@")) return String(recipient);
  return recipient + "@s.whatsapp.net";
}

/**
 * Render {{var}} templates by plain substitution — NO code evaluation path.
 * Unknown/missing placeholders stay visible so admins notice typos.
 */
function renderTemplate(template, vars) {
  return String(template ?? "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
    const value = vars ? vars[key] : undefined;
    return value === undefined || value === null ? match : String(value);
  });
}

/** Idempotency key: one notification per (order, type, recipient). */
function buildDedupeKey(orderId, type, recipient) {
  return `${orderId}:${type}:${recipient}`;
}

/** Retry backoff: 30s * 2^n capped at 10 minutes. */
function computeBackoffMs(retryCount) {
  return Math.min(30000 * Math.pow(2, Math.max(0, retryCount)), 10 * 60 * 1000);
}

/**
 * Rejects a non-retryable send failure (e.g. the recipient number has no
 * WhatsApp account). Retrying can never succeed until a human fixes the
 * number, so the queue marks these FAILED immediately instead of burning
 * retries — an admin can still retry manually from the panel.
 */
function recipientNotOnWhatsApp(recipient) {
  const err = new Error(
    `Number is not available on WhatsApp${recipient ? ` (${recipient})` : ""} — verify the customer phone number.`
  );
  err.nonRetryable = true;
  return err;
}

/**
 * Race a promise against a hard timeout. Baileys' sendMessage can hang
 * indefinitely on a half-dead WebSocket (phone offline, network drop the
 * keepalive has not noticed yet) — without this the queue row would sit in
 * "processing" forever and the message would silently never arrive.
 * The timer is always cleared; the losing promise's result/error is ignored.
 */
function withTimeout(promise, ms, label) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`WhatsApp send timed out after ${Math.round(ms / 1000)}s${label ? ` (${label})` : ""} — connection may be stale; will retry.`);
        err.timedOut = true;
        reject(err);
      }, Math.max(1, ms));
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Test messages must never look like real order notifications. */
function prefixTestMessage(message) {
  const text = String(message ?? "");
  return text.startsWith("[RoyalCarePK TEST]") ? text : `[RoyalCarePK TEST]\n\n${text}`;
}

/** Group JID sanity check (e.g. 1203630212-1555xxxx@g.us). */
function isGroupJid(jid) {
  return /^[0-9]{10,25}(-[0-9]+)?@g\.us$/.test(String(jid ?? ""));
}

/**
 * Transient Baileys/WhatsApp network errors that must NEVER take the bot
 * process down (408 "Timed Out" init queries, dropped sockets, restart
 * hints, service unavailability). loggedOut (401) is deliberately NOT in
 * this set — that path wipes the session and needs a fresh QR scan.
 */
const TRANSIENT_DISCONNECT_CODES = new Set([408, 411, 428, 440, 500, 502, 503, 515]);
const TRANSIENT_ERROR_RE =
  /timed ?out|connection closed|connection lost|stream errored|restart required|service unavailable|connection replaced|multidevice mismatch|conflict|precondition|fetch failed|network|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up/i;

function isTransientBaileysError(err) {
  if (!err) return false;
  const statusCode = err?.output?.statusCode ?? err?.statusCode;
  if (typeof statusCode === "number" && TRANSIENT_DISCONNECT_CODES.has(statusCode)) return true;
  return TRANSIENT_ERROR_RE.test(String(err?.message ?? err));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Digits before '@' with the device suffix stripped ("92300…:12" -> "92300…"). */
function jidPhone(jid) {
  return String(jid ?? "").split("@")[0].replace(/:[0-9]+$/, "") || null;
}

/**
 * Extract the displayable text of a Baileys message content. Handles the
 * common wrappers (ephemeral / viewOnce / documentWithCaption) and captioned
 * media. Non-text media get a readable placeholder so nothing arrives
 * invisibly. Returns { body, message_type } or null when nothing is showable.
 */
function extractInboxBody(message) {
  const m =
    message?.ephemeralMessage?.message ??
    message?.viewOnceMessage?.message ??
    message?.documentWithCaptionMessage?.message ??
    message;
  if (!m) return null;
  const candidates = [
    [m.conversation, "conversation"],
    [m.extendedTextMessage?.text, "extendedText"],
    [m.imageMessage?.caption, "image"],
    [m.videoMessage?.caption, "video"],
    [m.documentMessage?.caption, "document"],
  ];
  for (const [text, type] of candidates) {
    if (typeof text === "string" && text.trim()) return { body: text.trim(), message_type: type };
  }
  if (m.imageMessage) return { body: "[image]", message_type: "image" };
  if (m.videoMessage) return { body: "[video]", message_type: "video" };
  if (m.audioMessage) return { body: "[voice note]", message_type: "audio" };
  if (m.stickerMessage) return { body: "[sticker]", message_type: "sticker" };
  if (m.documentMessage) return { body: `[document ${m.documentMessage.fileName ?? ""}]`.trim(), message_type: "document" };
  return null; // protocol/reactions/sender-key payloads and other noise
}

/**
 * Normalize one Baileys message from `messages.upsert` into a whatsapp_inbox
 * row — or null when the message must NOT be logged:
 *   - status broadcasts (contact "about/status" updates, not conversations)
 *   - our OWN outgoing messages (fromMe echo — Message Logs already covers outbound)
 *   - protocol/empty payloads with no displayable content
 * Pure function: no I/O, no Baileys dependency — unit-testable anywhere.
 */
function parseIncomingMessage(accountId, m) {
  const key = m?.key;
  const remoteJid = key?.remoteJid;
  if (!key?.id || !remoteJid) return null; // no id -> cannot dedup; no jid -> not a chat
  if (remoteJid === "status@broadcast") return null;
  if (key.fromMe) return null;
  const text = extractInboxBody(m.message);
  if (!text) return null;
  const isGroup = remoteJid.endsWith("@g.us");
  const isBroadcast = remoteJid.endsWith("@broadcast");
  const senderJid = isGroup ? String(key.participant ?? remoteJid) : remoteJid;
  return {
    account_id: accountId ?? null,
    wa_message_id: String(key.id).slice(0, 255),
    chat_jid: remoteJid,
    chat_kind: isGroup ? "group" : isBroadcast ? "broadcast" : "direct",
    sender_jid: senderJid,
    sender_phone: jidPhone(senderJid),
    sender_name: m.pushName ?? null,
    body: text.body.slice(0, 8000),
    message_type: text.message_type,
    is_from_me: false,
    wa_timestamp: m.messageTimestamp
      ? new Date(Number(m.messageTimestamp) * 1000).toISOString()
      : null,
  };
}

module.exports = {
  normalizePkWhatsApp,
  toJid,
  renderTemplate,
  buildDedupeKey,
  computeBackoffMs,
  prefixTestMessage,
  isGroupJid,
  isTransientBaileysError,
  recipientNotOnWhatsApp,
  withTimeout,
  parseIncomingMessage,
  jidPhone,
  sleep,
};
