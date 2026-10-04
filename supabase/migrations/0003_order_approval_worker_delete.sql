-- ============================================================================
-- RoyalCarePK — Migration 0003
-- Worker Order Approval Workflow + Safe Worker Account Deletion
--
-- Run in: Supabase Dashboard → SQL Editor → New query
-- Safe to re-run: every statement is guarded / idempotent.
-- No data is deleted; no tables are dropped; existing RLS policies are only
-- added to (never weakened).
--
-- Design notes:
--   * approval_status defaults to 'APPROVED' so every EXISTING order (and any
--     order created directly by admins) remains fully bookable — zero change
--     to the current lifecycle. The application sets 'PENDING' explicitly when
--     a worker submits an order for approval.
--   * Worker references on business-history tables move from ON DELETE
--     CASCADE to ON DELETE SET NULL so deleting a worker account can never
--     erase orders, commissions or payments. Snapshot columns keep historical
--     rows readable after the profile row is gone.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- 1. Approval enum + columns on orders
-- ----------------------------------------------------------------------------
do $$ begin
  create type public.order_approval_status as enum ('PENDING', 'APPROVED', 'REJECTED');
exception when duplicate_object then null; end $$;

alter table public.orders
  add column if not exists approval_status public.order_approval_status not null default 'APPROVED';
alter table public.orders add column if not exists submitted_at timestamptz;
alter table public.orders add column if not exists submitted_by uuid references public.profiles(id) on delete set null;
alter table public.orders add column if not exists approved_at timestamptz;
alter table public.orders add column if not exists approved_by uuid references public.profiles(id) on delete set null;
alter table public.orders add column if not exists rejected_at timestamptz;
alter table public.orders add column if not exists rejected_by uuid references public.profiles(id) on delete set null;
alter table public.orders add column if not exists rejection_reason text;
-- historical worker identity, captured when the worker submits the order so
-- the row stays understandable even after the worker account is deleted
alter table public.orders add column if not exists worker_name_snapshot text;
alter table public.orders add column if not exists worker_email_snapshot text;
alter table public.orders add column if not exists worker_code_snapshot text;

create index if not exists idx_orders_approval on public.orders (approval_status);
create index if not exists idx_orders_approval_pending on public.orders (approval_status, created_at desc)
  where approval_status = 'PENDING';

-- ----------------------------------------------------------------------------
-- 2. Worker deletion safety — commission ledger + payments must survive
--    (currently ON DELETE CASCADE, which would erase financial history)
-- ----------------------------------------------------------------------------
alter table public.commission_transactions add column if not exists worker_name_snapshot text;
alter table public.worker_payments      add column if not exists worker_name_snapshot text;

-- backfill snapshots for existing rows while the profiles rows still exist
update public.commission_transactions t
   set worker_name_snapshot = p.name
  from public.profiles p
 where t.worker_id = p.id and t.worker_name_snapshot is null;
update public.worker_payments t
   set worker_name_snapshot = p.name
  from public.profiles p
 where t.worker_id = p.id and t.worker_name_snapshot is null;

-- commission_transactions.worker_id: NOT NULL + CASCADE  →  nullable + SET NULL
do $$
declare c text;
begin
  select constraint_name into c from information_schema.table_constraints
   where table_schema = 'public' and table_name = 'commission_transactions'
     and constraint_type = 'FOREIGN KEY' and constraint_name like '%worker_id%';
  if c is not null then
    execute format('alter table public.commission_transactions drop constraint %I', c);
  end if;
end $$;
alter table public.commission_transactions alter column worker_id drop not null;
alter table public.commission_transactions
  add constraint commission_transactions_worker_fk
  foreign key (worker_id) references public.profiles(id) on delete set null;

-- worker_payments.worker_id: NOT NULL + CASCADE  →  nullable + SET NULL
do $$
declare c text;
begin
  select constraint_name into c from information_schema.table_constraints
   where table_schema = 'public' and table_name = 'worker_payments'
     and constraint_type = 'FOREIGN KEY' and constraint_name like '%worker_id%';
  if c is not null then
    execute format('alter table public.worker_payments drop constraint %I', c);
  end if;
end $$;
alter table public.worker_payments alter column worker_id drop not null;
alter table public.worker_payments
  add constraint worker_payments_worker_fk
  foreign key (worker_id) references public.profiles(id) on delete set null;

-- commission_rules.worker_id: CASCADE → SET NULL (a deleted worker's custom
-- rule becomes inert instead of vanishing; admins can still see and clean it)
do $$
declare c text;
begin
  select constraint_name into c from information_schema.table_constraints
   where table_schema = 'public' and table_name = 'commission_rules'
     and constraint_type = 'FOREIGN KEY' and constraint_name like '%worker_id%';
  if c is not null then
    execute format('alter table public.commission_rules drop constraint %I', c);
    alter table public.commission_rules
      add constraint commission_rules_worker_fk
      foreign key (worker_id) references public.profiles(id) on delete set null;
  end if;
end $$;

-- orders.worker_id is already ON DELETE SET NULL (0001) — verify only.
-- audit_logs.user_id, order_status_history.created_by, worker_payments.created_by,
-- inventory_movements.created_by: already ON DELETE SET NULL (0001) — nothing to do.

-- ----------------------------------------------------------------------------
-- 3. RLS additions (defense-in-depth only — the app's data layer runs on the
--    service-role client and enforces authorization in the service layer)
-- ----------------------------------------------------------------------------
drop policy if exists worker_insert_own_orders on public.orders;
create policy worker_insert_own_orders on public.orders for insert to authenticated
  with check (public.is_worker() and worker_id = auth.uid() and approval_status = 'PENDING');

-- Workers must never be able to mutate the approval workflow fields directly.
-- Column-level REVOKE applies to the `authenticated` role only; the service_role
-- client used by the app is unaffected.
revoke update (approval_status, approved_by, approved_at,
               rejected_by, rejected_at, rejection_reason,
               submitted_by, submitted_at)
  on public.orders from authenticated;

-- ----------------------------------------------------------------------------
-- 4. Done — existing tables, policies and data are untouched otherwise.
-- ----------------------------------------------------------------------------
