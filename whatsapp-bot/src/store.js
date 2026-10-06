"use strict";
/** Supabase access for the bot — service role, server-side only, never in Git. */

const { createClient } = require("@supabase/supabase-js");

function createSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (copy .env.example to .env).");
    process.exit(1);
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Singleton row in whatsapp_bot_settings (pause flag, failover, delays). */
async function readBotSettings(sb) {
  const { data, error } = await sb.from("whatsapp_bot_settings").select("*").limit(1);
  if (error) throw error;
  const row = data?.[0] ?? null;
  return {
    paused: !!row?.paused,
    failover_enabled: !!row?.failover_enabled,
    send_delay_ms: Number(row?.send_delay_ms) || Number(process.env.WHATSAPP_SEND_DELAY_MS) || 2500,
    max_retries: Number(row?.max_retries ?? 3),
  };
}

/** routing rows keyed by notification type (BOOKED, OUT_FOR_DELIVERY, ...). */
async function readRouting(sb) {
  const { data, error } = await sb.from("whatsapp_routing_settings").select("*");
  if (error) throw error;
  const map = {};
  for (const row of data ?? []) map[row.notification_type] = row;
  return map;
}

async function updateAccount(sb, accountId, patch) {
  const { error } = await sb.from("whatsapp_accounts").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", accountId);
  if (error) console.error("[bot] account update failed:", error.message);
}

async function touchBotHeartbeat(sb) {
  const { data } = await sb.from("whatsapp_bot_settings").select("id").limit(1);
  if (data?.[0]) {
    await sb.from("whatsapp_bot_settings").update({ last_bot_seen_at: new Date().toISOString() }).eq("id", data[0].id);
  }
}

/** Insert a delivery attempt row into whatsapp_message_logs. */
async function writeAttemptLog(sb, queueId, attempt, status, accountId, error) {
  await sb.from("whatsapp_message_logs").insert({
    queue_id: queueId,
    attempt,
    status,
    account_id: accountId ?? null,
    error: error ?? null,
  });
}

/**
 * Store one incoming WhatsApp message in whatsapp_inbox (idempotent — the
 * WhatsApp message id is the unique dedup key, so Baileys re-deliveries after
 * a reconnect never create duplicates). Failures are logged, never thrown:
 * a logging hiccup must never disturb the live WhatsApp session.
 */
async function writeInboxMessage(sb, row) {
  const { error } = await sb
    .from("whatsapp_inbox")
    .insert(row, { onConflict: "wa_message_id", ignoreDuplicates: true });
  if (error) console.error("[bot] inbox write failed:", error.message);
}

module.exports = { createSupabase, readBotSettings, readRouting, updateAccount, touchBotHeartbeat, writeAttemptLog, writeInboxMessage };
