-- ============================================================================
-- RoyalCarePK migration 0005 — WhatsApp inbox (incoming message capture)
-- ============================================================================
-- ADDITIVE ONLY: creates ONE new table. No existing table is altered or
-- dropped. Migration 0003/0004 are untouched.
--
-- Why: the bot never registered a Baileys `messages.upsert` listener and no
-- storage for incoming messages existed, so inbound WhatsApp messages were
-- received by the socket and silently discarded. This table is written by
-- the local bot (service role) and read by Admin -> WhatsApp -> Incoming.
--
-- Apply via Supabase Dashboard -> SQL Editor (same procedure as 0004).
-- Fully idempotent: safe to re-run.
-- ============================================================================

create table if not exists whatsapp_inbox (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references whatsapp_accounts(id) on delete set null,
  -- WhatsApp message id = natural dedup key (Baileys can re-deliver on reconnect)
  wa_message_id text not null unique,
  -- Raw remote JID exactly as Baileys delivered it (@s.whatsapp.net / @lid / @g.us)
  chat_jid text not null,
  chat_kind text not null check (chat_kind in ('direct', 'group', 'broadcast')),
  sender_jid text,
  -- Best-effort digits before the '@' (device suffix ":12" stripped). For
  -- LID-format JIDs this keeps the LID digits — messages are never dropped.
  sender_phone text,
  sender_name text,
  body text,
  message_type text,
  is_from_me boolean not null default false,
  wa_timestamp timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_wa_inbox_created on whatsapp_inbox (created_at desc);
create index if not exists idx_wa_inbox_account on whatsapp_inbox (account_id);
create index if not exists idx_wa_inbox_phone on whatsapp_inbox (sender_phone);

-- ------------------------------------------------------------------ RLS -----
alter table whatsapp_inbox enable row level security;

-- staff read / super_admin write (same defense-in-depth model as 0004)
do $$
begin
  execute format('drop policy if exists wa_staff_read on %I', 'whatsapp_inbox');
  execute format('create policy wa_staff_read on %I for select to authenticated using (is_staff())', 'whatsapp_inbox');
  execute format('drop policy if exists wa_super_write on %I', 'whatsapp_inbox');
  execute format('create policy wa_super_write on %I for all to authenticated using (is_super_admin()) with check (is_super_admin())', 'whatsapp_inbox');
exception when undefined_function then null; -- is_staff()/is_super_admin() come from 0001
end $$;
