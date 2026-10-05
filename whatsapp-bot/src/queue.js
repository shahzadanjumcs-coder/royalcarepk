"use strict";
/**
 * Queue processor — the ONLY place that sends real order notifications.
 *
 * Guarantees:
 *  - claims one row at a time (processing) so a restart never double-sends an
 *    in-flight message; idempotency was already enforced at enqueue time
 *  - a message is "sent" ONLY after Baileys resolves the sendMessage promise
 *  - limited retries with exponential backoff, then failed + reason (admin can
 *    retry manually from the panel — no infinite loops anywhere)
 *  - paused bot = zero sends, queue rows stay stored
 *  - optional account failover, still duplicate-safe
 *  - sequential sends with a configurable delay (responsible rate limiting)
 */

const { toJid, computeBackoffMs } = require("./lib");
const { readBotSettings, readRouting, updateAccount, writeAttemptLog } = require("./store");

class QueueProcessor {
  constructor(sb, manager) {
    this.sb = sb;
    this.manager = manager;
    this.settings = { paused: false, failover_enabled: false, send_delay_ms: 2500, max_retries: 3 };
  }

  async refreshSettings() {
    try {
      this.settings = await readBotSettings(this.sb);
    } catch (e) {
      console.error("[bot] could not read bot settings:", e.message);
    }
    return this.settings;
  }

  /** Claim the oldest due message (pending/retrying). Returns null when idle. */
  async claimNext() {
    const nowIso = new Date().toISOString();
    const { data: candidates, error } = await this.sb
      .from("whatsapp_message_queue")
      .select("*")
      .in("status", ["pending", "retrying"])
      .lte("next_attempt_at", nowIso)
      .order("created_at", { ascending: true })
      .limit(1);
    if (error) throw error;
    const candidate = candidates?.[0];
    if (!candidate) return null;

    const { data: claimed, error: claimError } = await this.sb
      .from("whatsapp_message_queue")
      .update({ status: "processing", updated_at: nowIso })
      .eq("id", candidate.id)
      .in("status", ["pending", "retrying"])
      .select();
    if (claimError) throw claimError;
    return claimed?.[0] ?? null;
  }

  /** Pick a connected account for the message: routing primary -> default -> failover. */
  async pickAccount(item) {
    const routing = await readRouting(this.sb);
    const row = routing[item.notification_type];

    const { data: accounts } = await this.sb.from("whatsapp_accounts").select("*");
    const byId = new Map((accounts ?? []).map((a) => [a.id, a]));
    const connected = (accounts ?? []).filter((a) => a.enabled && this.manager.isConnected(a.id));

    const tryAccount = (id) => {
      if (!id) return null;
      const account = byId.get(id);
      return account && account.enabled && this.manager.isConnected(account.id) ? account : null;
    };

    const primary = tryAccount(row?.account_id);
    if (primary) return { account: primary, usedFailover: false };

    const { data: defaults } = await this.sb.from("whatsapp_accounts").select("*").eq("is_default", true).limit(1);
    const fallbackDefault = tryAccount(defaults?.[0]?.id);
    if (fallbackDefault) return { account: fallbackDefault, usedFailover: false };

    if (this.settings.failover_enabled) {
      const configured = tryAccount(row?.fallback_account_id);
      if (configured) return { account: configured, usedFailover: true };
      const anyConnected = connected.find((a) => a.enabled) ?? null;
      if (anyConnected) return { account: anyConnected, usedFailover: true };
    }
    return { account: null, usedFailover: false };
  }

  /** Send one claimed message end-to-end. Returns true when it was handled. */
  async processOne() {
    const item = await this.claimNext();
    if (!item) return false;

    const attemptNo = (item.retry_count ?? 0) + 1;
    const { account, usedFailover } = await this.pickAccount(item);
    const jid = toJid(item.recipient, item.recipient_kind);

    if (!account) {
      const reason = "No connected WhatsApp account for this notification type (connect a number in the admin panel).";
      await this.fail(item, attemptNo, null, reason);
      console.warn(`[bot] ${item.notification_type} for ${item.order_number ?? item.id}: ${reason}`);
      return true;
    }

    try {
      await this.manager.sendText(account.id, jid, item.message);
      // sent = confirmed by the WhatsApp session
      await this.sb
        .from("whatsapp_message_queue")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          account_id: account.id,
          account_name: account.name,
          failure_reason: null,
          retry_count: item.retry_count ?? 0,
          updated_at: new Date().toISOString(),
        })
        .eq("id", item.id);
      await writeAttemptLog(this.sb, item.id, attemptNo, "sent", account.id, null);
      console.log(
        `[bot] SENT ${item.notification_type} order=${item.order_number ?? "-"} via "${account.name}"${usedFailover ? " (FAILOVER)" : ""}`
      );
    } catch (e) {
      await this.fail(item, attemptNo, account.id, e.message ?? "WhatsApp send failed.");
      console.error(`[bot] send failed (${item.notification_type}, order=${item.order_number ?? "-"}):`, e.message);
    }
    return true;
  }

  /** Record a failed attempt: retry with backoff while attempts remain, then failed. */
  async fail(item, attemptNo, accountId, reason) {
    const retryCount = (item.retry_count ?? 0) + 1;
    const maxRetries = item.max_retries ?? this.settings.max_retries ?? 3;
    const exhausted = retryCount > maxRetries;
    const nextAttempt = new Date(Date.now() + computeBackoffMs(retryCount - 1)).toISOString();

    await this.sb
      .from("whatsapp_message_queue")
      .update({
        status: exhausted ? "failed" : "retrying",
        retry_count: retryCount,
        failure_reason: reason,
        next_attempt_at: exhausted ? item.next_attempt_at : nextAttempt,
        updated_at: new Date().toISOString(),
      })
      .eq("id", item.id);
    await writeAttemptLog(this.sb, item.id, attemptNo, "failed", accountId, reason);
    if (exhausted) {
      console.error(`[bot] message ${item.id} FAILED permanently: ${reason}`);
    }
  }
}

module.exports = { QueueProcessor };
