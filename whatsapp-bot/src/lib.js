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

/** Test messages must never look like real order notifications. */
function prefixTestMessage(message) {
  const text = String(message ?? "");
  return text.startsWith("[RoyalCarePK TEST]") ? text : `[RoyalCarePK TEST]\n\n${text}`;
}

/** Group JID sanity check (e.g. 1203630212-1555xxxx@g.us). */
function isGroupJid(jid) {
  return /^[0-9]{10,25}(-[0-9]+)?@g\.us$/.test(String(jid ?? ""));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

module.exports = {
  normalizePkWhatsApp,
  toJid,
  renderTemplate,
  buildDedupeKey,
  computeBackoffMs,
  prefixTestMessage,
  isGroupJid,
  sleep,
};
