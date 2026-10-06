-- ============================================================================
-- RoyalCarePK — 0008: WhatsApp delivery evidence
-- ----------------------------------------------------------------------------
-- Makes "SENT" provable. Until now the queue said "sent" whenever Baileys'
-- sendMessage promise resolved, with NO stored WhatsApp message id and NO
-- downstream acks — so a message that silently vanished (recipient not on
-- WhatsApp, zombie socket, wrong Supabase project) was indistinguishable
-- from one that actually landed on the phone.
--
-- Adds, fully additively (NO existing column is altered or dropped):
--   whatsapp_message_queue.wa_message_id      — the real WhatsApp message id
--                                               returned by sendMessage
--   whatsapp_message_queue.wa_delivery_status — forward-only Baileys ack:
--                                               SENT (server ack) -> DELIVERED
--                                               (recipient device) -> READ
--   whatsapp_message_queue.delivered_at       — first DELIVERED-or-later ack
--   whatsapp_message_logs.wa_message_id       — per-attempt send evidence
--
-- The bot (whatsapp-bot/) writes these via the service-role client; RLS is
-- unchanged. Safe to re-run.
-- ============================================================================

alter table whatsapp_message_queue add column if not exists wa_message_id text;
alter table whatsapp_message_queue add column if not exists wa_delivery_status text;
alter table whatsapp_message_queue add column if not exists delivered_at timestamptz;
alter table whatsapp_message_logs add column if not exists wa_message_id text;

-- Constraint mirrors the bot's forward-only ack writer (SENT < DELIVERED < READ).
do $$ begin
  alter table whatsapp_message_queue
    add constraint whatsapp_queue_delivery_status_check
    check (wa_delivery_status is null or wa_delivery_status in ('SENT','DELIVERED','READ'));
exception when duplicate_object then null; end $$;

-- Lookup by WhatsApp message id (delivery-ack resolution + admin verification).
create index if not exists idx_wa_queue_wa_message_id on whatsapp_message_queue (wa_message_id);
