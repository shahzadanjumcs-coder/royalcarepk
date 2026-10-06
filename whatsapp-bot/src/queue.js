"use strict";
/**
 * Queue processor — the ONLY place that sends real order notifications.
 *
 * Guarantees:
 *  - claims one row at a time (processing) so a restart never double-sends an
 *    in-flight message; idempotency was already enforced at enqueue time
 *  - a message is "sent" ONLY after the real Baileys sendMessage resolves —
 *    and the returned WhatsApp message id is stored as evidence on the queue
 *    row + attempt log. Baileys delivery acks later bump SENT -> DELIVERED ->
 *    READ (forward-only), so "sent" never pretends "landed on the phone"
 *  - zombie sockets cannot hang the pipeline: every send races a hard timeout
 *    and rows abandoned in "processing" (bot crash mid-send) are requeued by
 *    the stale-processing reaper
 *  - non-retryable failures (recipient has no WhatsApp account) fail
 *    immediately with the exact reason instead of burning retries
 *  - limited retries with exponential backoff, then failed + reason (admin can
 *    retry manually from the panel — no infinite loops anywhere)
 *  - paused bot = zero sends, queue rows stay stored
 *  - optional account failover, still duplicate-safe
 *  - sequential sends with a configurable delay (responsible rate limiting)
 */

const { toJid, computeBackoffMs } = require("./lib");
const { readBotSettings, readRouting, updateAccount, writeAttemptLog } = require("./store");

/** Rows stuck in "processing" older than this are reclaimed by requeueStale(). */
const STALE_PROCESSING_MS = 3 * 60 * 1000;

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
    if (claimed?.[0]) console.log(`[WA] Queue picked: ${claimed[0].notification_type} recipient=${claimed[0].recipient} (queue ${claimed[0].id})`);
    return claimed?.[0] ?? null;
  }

  /**
   * Reclaim rows abandoned in "processing" — e.g. the bot crashed or the
   * socket hung mid-send and was restarted. Without this they would sit in
   * processing forever, invisible to claimNext, while the admin log shows a
   * message that never completes. Guarded update: an in-flight claim by
   * another bot process can never be stolen.
   */
  async requeueStale() {
    const cutoff = new Date(Date.now() - STALE_PROCESSING_MS).toISOString();
    const { data: stale, error } = await this.sb
      .from("whatsapp_message_queue")
      .select("id")
      .eq("status", "processing")
      .lt("updated_at", cutoff)
      .limit(10);
    if (error) throw error;
    for (const row of stale ?? []) {
      const { data: reclaimed } = await this.sb
        .from("whatsapp_message_queue")
        .update({ status: "pending", updated_at: new Date().toISOString() })
        .eq("id", row.id)
        .eq("status", "processing")
        .lt("updated_at", cutoff)
        .select();
      if (reclaimed?.length) console.warn(`[WA] Requeued stale processing row ${row.id} (bot restarted mid-send?)`);
    }
    return (stale ?? []).length;
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
      const anyConnected = connected[0] ?? null;
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

    console.log(`[WA] Account selected: "${account.name}" (${account.id})${usedFailover ? " [FAILOVER]" : ""}`);
    try {
      // REAL send — resolves only when the connected Baileys session accepts
      // the message; throws (timeout / not-on-WhatsApp / socket dead) otherwise.
      const { waMessageId } = await this.manager.sendText(account.id, jid, item.message);
      // sent = confirmed by the WhatsApp session, WITH evidence.
      // CRITICAL: the message HAS been sent — an evidence-write failure must
      // never push this row back to retry (that would deliver it twice).
      try {
        await this.sb
          .from("whatsapp_message_queue")
          .update({
            status: "sent",
            sent_at: new Date().toISOString(),
            account_id: account.id,
            account_name: account.name,
            wa_message_id: waMessageId ?? null,
            failure_reason: null,
            retry_count: item.retry_count ?? 0,
            updated_at: new Date().toISOString(),
          })
          .eq("id", item.id);
      } catch (evidenceError) {
        console.error(`[WA] send evidence write failed (${evidenceError.message}) — retrying with status-only update; did you apply migration 0008?`);
        try {
          await this.sb
            .from("whatsapp_message_queue")
            .update({ status: "sent", sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq("id", item.id);
        } catch (statusError) {
          console.error(`[WA] CRITICAL: real send happened but the queue row could not be marked sent: ${statusError.message}`);
        }
      }
      try {
        await writeAttemptLog(this.sb, item.id, attemptNo, "sent", account.id, null, waMessageId ?? null);
      } catch (logError) {
        console.error(`[WA] attempt log write failed: ${logError.message}`);
      }
      console.log(
        `[WA] Queue marked SENT: ${item.notification_type} order=${item.order_number ?? "-"} via "${account.name}"${usedFailover ? " (FAILOVER)" : ""} wa_id=${waMessageId ?? "-"}`
      );
    } catch (e) {
      // A number with no WhatsApp account can never receive the message —
      // retrying would just delay the inevitable. Mark FAILED immediately.
      const nonRetryable = e?.nonRetryable === true;
      await this.fail(item, attemptNo, account.id, e.message ?? "WhatsApp send failed.", nonRetryable);
      console.error(`[WA] Send failed: ${e.message ?? e}`);
    }
    return true;
  }

  /** Record a failed attempt: retry with backoff while attempts remain, then failed. */
  async fail(item, attemptNo, accountId, reason, nonRetryable = false) {
    const retryCount = (item.retry_count ?? 0) + 1;
    const maxRetries = nonRetryable ? 0 : (item.max_retries ?? this.settings.max_retries ?? 3);
    const exhausted = nonRetryable || retryCount > maxRetries;
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
    await writeAttemptLog(this.sb, item.id, attemptNo, "failed", accountId, reason, null);
    if (exhausted) {
      console.error(`[bot] message ${item.id} FAILED permanently: ${reason}`);
    }
  }
}

module.exports = { QueueProcessor };
