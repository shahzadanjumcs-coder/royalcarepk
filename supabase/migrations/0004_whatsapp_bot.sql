-- ============================================================================
-- RoyalCarePK — 0004: WhatsApp notification bot (multi-account)
-- ----------------------------------------------------------------------------
-- Adds the WhatsApp Web automation layer:
--   whatsapp_accounts            — multiple WhatsApp numbers with isolated sessions
--   whatsapp_routing_settings    — which account sends which notification type (+ template)
--   whatsapp_admin_recipients    — admin numbers for RETURNED / alerts
--   whatsapp_group_settings      — Flaship WhatsApp group(s) for SHIPPER ADVISE
--   whatsapp_bot_settings        — singleton: pause, failover, rate limits, bot heartbeat
--   whatsapp_message_queue       — reliable outbox with idempotency + retries
--   whatsapp_message_logs        — per-attempt delivery history
--   whatsapp_commands            — admin panel -> bot control channel (pair/logout/test/...)
--
-- Conventions (same as 0001-0003): fully idempotent, non-destructive, RLS on
-- everything. The app and the bot both use the service-role client; RLS here is
-- defense-in-depth (staff read / super_admin write), mirroring flaship tables.
--
-- NO existing RoyalCarePK table is altered or dropped.
-- Migration 0003 (approval workflow) is untouched — do NOT re-run it.
-- ============================================================================

-- ---------------------------------------------------------------- enums -----
do $$ begin
  create type whatsapp_account_status as enum ('connecting', 'connected', 'disconnected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type whatsapp_notification_type as enum (
    'BOOKED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RETURNED', 'SHIPPER_ADVISE'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type whatsapp_msg_status as enum (
    'pending', 'processing', 'sent', 'failed', 'retrying', 'cancelled'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type whatsapp_command_status as enum ('pending', 'processing', 'done', 'failed');
exception when duplicate_object then null; end $$;

-- ------------------------------------------------------------ accounts ------
create table if not exists whatsapp_accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  status whatsapp_account_status not null default 'disconnected',
  enabled boolean not null default true,
  is_default boolean not null default false,
  -- QR payload (data URL) for pairing — short-lived, cleared after connect
  qr_code text,
  qr_updated_at timestamptz,
  last_connected_at timestamptz,
  last_disconnected_at timestamptz,
  last_error text,
  -- bot heartbeat for this account's session (bot writes every ~15s)
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_accounts_name_unique unique (name)
);

-- ------------------------------------------------------------- routing ------
-- One row per notification type. template uses {{safe_var}} placeholders only.
create table if not exists whatsapp_routing_settings (
  id uuid primary key default gen_random_uuid(),
  notification_type whatsapp_notification_type not null unique,
  account_id uuid references whatsapp_accounts(id) on delete set null,
  fallback_account_id uuid references whatsapp_accounts(id) on delete set null,
  enabled boolean not null default true,
  template text not null,
  updated_at timestamptz not null default now()
);

-- --------------------------------------------------- admin recipients -------
create table if not exists whatsapp_admin_recipients (
  id uuid primary key default gen_random_uuid(),
  label text not null default 'Admin',
  phone text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------- group settings -----
create table if not exists whatsapp_group_settings (
  id uuid primary key default gen_random_uuid(),
  label text not null default 'Flaship Group',
  group_jid text not null unique,
  account_id uuid references whatsapp_accounts(id) on delete set null,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- -------------------------------------------------------- bot settings ------
create table if not exists whatsapp_bot_settings (
  id uuid primary key default gen_random_uuid(),
  paused boolean not null default false,
  failover_enabled boolean not null default false,
  send_delay_ms integer not null default 2500 check (send_delay_ms between 500 and 60000),
  max_retries integer not null default 3 check (max_retries between 0 and 10),
  last_bot_seen_at timestamptz,
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------ message queue -------
-- dedupe_key is the idempotency lock: one notification per (order, type,
-- recipient). Re-processed events hit the UNIQUE index and are ignored.
create table if not exists whatsapp_message_queue (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references orders(id) on delete set null,
  order_number text,
  notification_type whatsapp_notification_type not null,
  recipient text not null,
  recipient_kind text not null default 'customer'
    check (recipient_kind in ('customer', 'admin', 'group')),
  account_id uuid references whatsapp_accounts(id) on delete set null,
  account_name text,
  message text not null,
  status whatsapp_msg_status not null default 'pending',
  retry_count integer not null default 0,
  max_retries integer not null default 3,
  next_attempt_at timestamptz not null default now(),
  failure_reason text,
  dedupe_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists idx_wa_queue_status_next on whatsapp_message_queue (status, next_attempt_at);
create index if not exists idx_wa_queue_order on whatsapp_message_queue (order_id);
create index if not exists idx_wa_queue_created on whatsapp_message_queue (created_at desc);

-- -------------------------------------------------------- message logs ------
create table if not exists whatsapp_message_logs (
  id uuid primary key default gen_random_uuid(),
  queue_id uuid references whatsapp_message_queue(id) on delete cascade,
  attempt integer not null default 1,
  status text not null check (status in ('sent', 'failed')),
  account_id uuid references whatsapp_accounts(id) on delete set null,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists idx_wa_logs_queue on whatsapp_message_logs (queue_id);
create index if not exists idx_wa_logs_created on whatsapp_message_logs (created_at desc);

-- ------------------------------------------------------------- commands -----
-- Admin panel inserts a command row; the bot polls, executes and reports back.
create table if not exists whatsapp_commands (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references whatsapp_accounts(id) on delete set null,
  command text not null
    check (command in ('connect','logout','remove','test_message','test_group','list_groups','status_sync')),
  payload jsonb not null default '{}'::jsonb,
  status whatsapp_command_status not null default 'pending',
  result text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists idx_wa_commands_status on whatsapp_commands (status, created_at);

-- ----------------------------------------------------------------- RLS ------
alter table whatsapp_accounts enable row level security;
alter table whatsapp_routing_settings enable row level security;
alter table whatsapp_admin_recipients enable row level security;
alter table whatsapp_group_settings enable row level security;
alter table whatsapp_bot_settings enable row level security;
alter table whatsapp_message_queue enable row level security;
alter table whatsapp_message_logs enable row level security;
alter table whatsapp_commands enable row level security;

-- staff read / super_admin write (same defense-in-depth model as flaship_*)
do $$
declare t text;
begin
  foreach t in array array[
    'whatsapp_accounts','whatsapp_routing_settings','whatsapp_admin_recipients',
    'whatsapp_group_settings','whatsapp_bot_settings','whatsapp_message_queue',
    'whatsapp_message_logs','whatsapp_commands'
  ] loop
    execute format('drop policy if exists wa_staff_read on %I', t);
    execute format('create policy wa_staff_read on %I for select to authenticated using (is_staff())', t);
    execute format('drop policy if exists wa_super_write on %I', t);
    execute format('create policy wa_super_write on %I for all to authenticated using (is_super_admin()) with check (is_super_admin())', t);
  end loop;
exception when undefined_function then null; -- is_staff()/is_super_admin() come from 0001
end $$;

-- ---------------------------------------------------------------- seeds -----
-- Singleton bot settings row
insert into whatsapp_bot_settings (paused, failover_enabled, send_delay_ms, max_retries)
select false, false, 2500, 3
where not exists (select 1 from whatsapp_bot_settings);

-- Default routing + professional templates (only inserted when missing so
-- admin edits are never overwritten by re-running this migration).
-- NOTE: each enum literal MUST be explicitly cast to whatsapp_notification_type.
-- Inside a "from (values ...) as seed(...)" derived table PostgreSQL resolves
-- bare string literals to type "text", which would make both the
-- "r.notification_type = seed.notification_type" comparison and the INSERT
-- fail with "operator does not exist: whatsapp_notification_type = text".
insert into whatsapp_routing_settings (notification_type, enabled, template)
select * from (values
  ('BOOKED'::whatsapp_notification_type, true,
E'Assalam-o-Alaikum {{customer_name}},\nYour order {{order_number}} has been booked successfully.\nCourier: {{courier}}\nTracking/CN: {{cn_number}}\nThank you for choosing RoyalCarePK.'),
  ('OUT_FOR_DELIVERY'::whatsapp_notification_type, true,
E'Assalam-o-Alaikum {{customer_name}},\nYour order {{order_number}} is out for delivery today.\nTracking/CN: {{cn_number}}\nPlease keep your phone available for the rider.'),
  ('DELIVERED'::whatsapp_notification_type, true,
E'Assalam-o-Alaikum {{customer_name}},\nYour order {{order_number}} has been delivered successfully.\nThank you for choosing RoyalCarePK.'),
  ('RETURNED'::whatsapp_notification_type, true,
E'RoyalCarePK Alert\nOrder {{order_number}} has been returned.\nCustomer: {{customer_name}}\nCN: {{cn_number}}\nReason: {{return_reason}}'),
  ('SHIPPER_ADVISE'::whatsapp_notification_type, true,
E'RoyalCarePK / Flaship Update\nOrder: {{order_number}}\nCustomer: {{customer_name}}\nCN: {{cn_number}}\nStatus: SHIPPER ADVISE\nReason: {{reason}}')
) as seed(notification_type, enabled, template)
where not exists (
  select 1 from whatsapp_routing_settings r where r.notification_type = seed.notification_type
);
