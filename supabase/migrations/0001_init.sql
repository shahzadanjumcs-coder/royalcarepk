-- ============================================================================
-- CourierOps — Supabase schema, indexes, RLS policies & helpers
-- Run this whole file in: Supabase Dashboard → SQL Editor → New query
-- Safe to re-run: statements are guarded where practical.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------
do $$ begin
  create type public.user_role as enum ('super_admin', 'admin', 'worker', 'inventory_manager');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.user_status as enum ('active', 'disabled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.order_status as enum
    ('CREATED','PENDING','ASSIGNED','BOOKED','IN_TRANSIT','DELIVERED','RETURNED','CANCELLED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.booking_status as enum ('not_booked','pending','booked','failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.commission_type as enum
    ('DELIVERED_COMMISSION','RETURN_ADJUSTMENT','MANUAL_ADJUSTMENT');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payment_method as enum ('CASH','BANK_TRANSFER','OTHER');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.movement_type as enum
    ('PURCHASE','STOCK_IN','STOCK_OUT','ORDER_RESERVE','ORDER_RELEASE','DELIVERY','RETURN','ADJUSTMENT');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.notification_type as enum ('info','success','warning','error');
exception when duplicate_object then null; end $$;

-- ----------------------------------------------------------------------------
-- Core tables
-- ----------------------------------------------------------------------------

-- profiles (1:1 with auth.users; app-facing user data)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  name text not null,
  phone text,
  role public.user_role not null default 'worker',
  worker_code text unique,
  team_id uuid,
  commission_rate numeric(5,2) not null default 0,
  status public.user_status not null default 'active',
  cnic text,
  address text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  leader_id uuid references public.profiles(id) on delete set null,
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now()
);

alter table public.profiles
  add constraint profiles_team_fk foreign key (team_id) references public.teams(id) on delete set null;

create table if not exists public.team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role_in_team text not null default 'Rider',
  joined_at timestamptz not null default now(),
  unique (team_id, user_id)
);

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null,
  email text,
  address text,
  city text,
  status text not null default 'active' check (status in ('active','disabled')),
  notes text,
  created_at timestamptz not null default now(),
  unique (phone)
);

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now()
);

create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  contact_person text,
  phone text,
  email text,
  address text,
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sku text not null unique,
  barcode text unique,
  category_id uuid references public.categories(id) on delete set null,
  supplier_id uuid references public.suppliers(id) on delete set null,
  purchase_price numeric(12,2) not null default 0 check (purchase_price >= 0),
  selling_price numeric(12,2) not null default 0 check (selling_price >= 0),
  current_stock integer not null default 0 check (current_stock >= 0),
  reserved_stock integer not null default 0 check (reserved_stock >= 0),
  min_stock integer not null default 5 check (min_stock >= 0),
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- stock movement ledger (append-only)
create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  order_id uuid,
  type public.movement_type not null,
  quantity integer not null default 0,
  reserved_change integer not null default 0,
  balance_after integer not null default 0,
  reserved_after integer not null default 0,
  note text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  customer_id uuid not null references public.customers(id) on delete restrict,
  worker_id uuid references public.profiles(id) on delete set null,
  status public.order_status not null default 'PENDING',
  subtotal numeric(12,2) not null default 0 check (subtotal >= 0),
  discount numeric(12,2) not null default 0 check (discount >= 0),
  total numeric(12,2) not null default 0 check (total >= 0),
  cod_amount numeric(12,2) not null default 0 check (cod_amount >= 0),
  delivery_address text not null,
  city text,
  notes text,
  -- commission rate snapshot (locked at assignment; never recalculated)
  commission_rate numeric(5,2),
  commission_rate_locked_at timestamptz,
  -- flaship
  booking_status public.booking_status not null default 'not_booked',
  flaship_booking_id text unique,
  tracking_number text unique,
  flaship_courier_name text,
  pickup_location_name text,
  booking_error text,
  booked_at timestamptz,
  last_synced_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name text not null,
  sku text,
  quantity integer not null check (quantity > 0),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  line_total numeric(12,2) not null
);

create table if not exists public.order_status_history (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  status public.order_status not null,
  note text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.shipments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  courier_name text,
  tracking_number text,
  booking_id text,
  destination_city text,
  pickup_location text,
  shipment_status text,
  booked_at timestamptz default now(),
  last_synced_at timestamptz,
  unique (order_id, tracking_number)
);

create table if not exists public.shipment_tracking (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  shipment_id uuid references public.shipments(id) on delete cascade,
  status text not null,
  description text,
  location text,
  scanned_at timestamptz not null default now(),
  raw jsonb
);

-- commission ledger — append-only; balances are always derived
create table if not exists public.commission_transactions (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references public.profiles(id) on delete cascade,
  order_id uuid references public.orders(id) on delete set null,
  type public.commission_type not null,
  amount numeric(12,2) not null,
  rate numeric(5,2),
  description text,
  created_at timestamptz not null default now()
);

-- idempotency: one credit + one deduction per order max (manual adjustments exempt)
create unique index if not exists commission_once_per_order
  on public.commission_transactions (order_id, type)
  where order_id is not null and type in ('DELIVERED_COMMISSION','RETURN_ADJUSTMENT');

create table if not exists public.commission_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  worker_id uuid references public.profiles(id) on delete cascade,
  scope text not null default 'default' check (scope in ('default','worker')),
  rate numeric(5,2) not null check (rate >= 0 and rate <= 100),
  status text not null default 'active' check (status in ('active','inactive')),
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.worker_payments (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references public.profiles(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  method public.payment_method not null default 'CASH',
  payment_date date not null default current_date,
  reference text,
  note text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- flaship reference catalogs
create table if not exists public.flaship_couriers (
  id uuid primary key default gen_random_uuid(),
  courier_id text not null unique,
  name text not null,
  active boolean not null default true,
  synced_at timestamptz
);

create table if not exists public.flaship_cities (
  id uuid primary key default gen_random_uuid(),
  city_id text not null unique,
  name text not null,
  province text,
  active boolean not null default true,
  synced_at timestamptz
);

create table if not exists public.flaship_pickups (
  id uuid primary key default gen_random_uuid(),
  pickup_id text not null unique,
  name text not null,
  address text,
  city text,
  contact text,
  active boolean not null default true,
  synced_at timestamptz
);

-- flaship request/response logs (secrets redacted by the app before insert)
create table if not exists public.flaship_logs (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id) on delete set null,
  endpoint text not null,
  method text not null default 'GET',
  status_code integer,
  success boolean not null default true,
  duration_ms integer,
  request_redacted text,
  response text,
  error text,
  created_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  title text not null,
  message text not null,
  type public.notification_type not null default 'info',
  link text,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  user_name text,
  action text not null,
  entity text not null,
  entity_id uuid,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.settings (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Indexes
-- ----------------------------------------------------------------------------
create index if not exists idx_orders_status        on public.orders (status);
create index if not exists idx_orders_worker        on public.orders (worker_id);
create index if not exists idx_orders_customer      on public.orders (customer_id);
create index if not exists idx_orders_created_at    on public.orders (created_at desc);
create index if not exists idx_orders_booking       on public.orders (booking_status);
create index if not exists idx_order_items_order    on public.order_items (order_id);
create index if not exists idx_history_order        on public.order_status_history (order_id, created_at);
create index if not exists idx_commission_worker    on public.commission_transactions (worker_id);
create index if not exists idx_commission_order     on public.commission_transactions (order_id);
create index if not exists idx_payments_worker      on public.worker_payments (worker_id);
create index if not exists idx_payments_date        on public.worker_payments (payment_date);
create index if not exists idx_movements_product    on public.inventory_movements (product_id, created_at desc);
create index if not exists idx_movements_order      on public.inventory_movements (order_id);
create index if not exists idx_tracking_order       on public.shipment_tracking (order_id, scanned_at);
create index if not exists idx_notifications_user   on public.notifications (user_id, read);
create index if not exists idx_audit_created        on public.audit_logs (created_at desc);
create index if not exists idx_products_sku         on public.products (sku);
create index if not exists idx_products_status      on public.products (status);

-- ----------------------------------------------------------------------------
-- RLS helpers
-- ----------------------------------------------------------------------------
create or replace function public.current_profile_role()
returns public.user_role
language sql stable security definer set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select coalesce(public.current_profile_role() in ('super_admin','admin'), false); $$;

create or replace function public.is_super_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select coalesce(public.current_profile_role() = 'super_admin', false); $$;

create or replace function public.is_inventory_manager()
returns boolean language sql stable security definer set search_path = public
as $$ select coalesce(public.current_profile_role() = 'inventory_manager', false); $$;

create or replace function public.is_worker()
returns boolean language sql stable security definer set search_path = public
as $$ select coalesce(public.current_profile_role() = 'worker', false); $$;

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public
as $$ select coalesce(public.current_profile_role() in ('super_admin','admin','inventory_manager'), false); $$;

-- ----------------------------------------------------------------------------
-- Auto-create profile on signup (default role: worker, disabled until approved
-- is intentionally NOT applied — change to 'disabled' if you want manual approval)
-- ----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  first_user boolean;
begin
  select not exists(select 1 from public.profiles) into first_user;
  insert into public.profiles (id, email, name, role, worker_code, commission_rate)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    case when first_user then 'super_admin'::public.user_role else 'worker'::public.user_role end,
    case when first_user then null else 'W-' || lpad((floor(random()*9000)+1000)::text, 4, '0') end,
    case when first_user then 0 else 5 end
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- Enable RLS on every table
-- ----------------------------------------------------------------------------
alter table public.profiles                enable row level security;
alter table public.teams                   enable row level security;
alter table public.team_members            enable row level security;
alter table public.customers               enable row level security;
alter table public.categories              enable row level security;
alter table public.suppliers               enable row level security;
alter table public.products                enable row level security;
alter table public.inventory_movements     enable row level security;
alter table public.orders                  enable row level security;
alter table public.order_items             enable row level security;
alter table public.order_status_history    enable row level security;
alter table public.shipments               enable row level security;
alter table public.shipment_tracking       enable row level security;
alter table public.commission_transactions enable row level security;
alter table public.commission_rules        enable row level security;
alter table public.worker_payments         enable row level security;
alter table public.flaship_couriers        enable row level security;
alter table public.flaship_cities          enable row level security;
alter table public.flaship_pickups         enable row level security;
alter table public.flaship_logs            enable row level security;
alter table public.notifications           enable row level security;
alter table public.audit_logs              enable row level security;
alter table public.settings                enable row level security;

-- ----------------------------------------------------------------------------
-- Policies
-- ----------------------------------------------------------------------------
do $$
declare
  t text;
  staff_tables text[] := array['customers','orders','order_items','order_status_history','shipments',
    'shipment_tracking','teams','team_members','commission_rules','flaship_couriers','flaship_cities','flaship_pickups'];
  inv_tables text[] := array['products','categories','suppliers','inventory_movements'];
begin
  -- staff (admin/admin-manager/inv-manager): full access to operational tables
  foreach t in array staff_tables loop
    execute format('drop policy if exists staff_all on public.%I;', t);
    execute format('create policy staff_all on public.%I for all to authenticated using (public.is_staff()) with check (public.is_staff());', t);
  end loop;

  -- inventory manager: manage inventory tables; workers read-only catalogs
  foreach t in array inv_tables loop
    execute format('drop policy if exists inv_manage on public.%I;', t);
    execute format('create policy inv_manage on public.%I for all to authenticated using (public.is_staff()) with check (public.is_staff());', t);
    execute format('drop policy if exists worker_read on public.%I;', t);
    execute format('create policy worker_read on public.%I for select to authenticated using (true);', t);
  end loop;
end $$;

-- profiles: everyone reads basic info (needed for names); self-update only; super_admin manages
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (true);
drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid() and role = public.current_profile_role());
drop policy if exists profiles_admin_write on public.profiles;
create policy profiles_admin_write on public.profiles for all to authenticated
  using (public.is_super_admin()) with check (public.is_super_admin());

-- workers see ONLY their own orders
drop policy if exists worker_own_orders on public.orders;
create policy worker_own_orders on public.orders for select to authenticated
  using (worker_id = auth.uid());

drop policy if exists worker_own_order_items on public.order_items;
create policy worker_own_order_items on public.order_items for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and o.worker_id = auth.uid()));

drop policy if exists worker_own_history on public.order_status_history;
create policy worker_own_history on public.order_status_history for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and o.worker_id = auth.uid()));

drop policy if exists worker_own_shipments on public.shipments;
create policy worker_own_shipments on public.shipments for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and o.worker_id = auth.uid()));

drop policy if exists worker_own_tracking on public.shipment_tracking;
create policy worker_own_tracking on public.shipment_tracking for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and o.worker_id = auth.uid()));

-- workers see ONLY their own commission + payments
drop policy if exists worker_own_commission on public.commission_transactions;
create policy worker_own_commission on public.commission_transactions for select to authenticated
  using (worker_id = auth.uid());
drop policy if exists staff_commission on public.commission_transactions;
create policy staff_commission on public.commission_transactions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists worker_own_payments on public.worker_payments;
create policy worker_own_payments on public.worker_payments for select to authenticated
  using (worker_id = auth.uid());
drop policy if exists staff_payments on public.worker_payments;
create policy staff_payments on public.worker_payments for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- flaship logs: admins only; audit logs: admins read, authenticated insert via app
drop policy if exists admin_flaship_logs on public.flaship_logs;
create policy admin_flaship_logs on public.flaship_logs for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists insert_audit on public.audit_logs;
create policy insert_audit on public.audit_logs for insert to authenticated with check (true);
drop policy if exists admin_audit on public.audit_logs;
create policy admin_audit on public.audit_logs for select to authenticated using (public.is_admin());

-- notifications: own (workers) + admins see the global admin feed (user_id is null)
drop policy if exists own_notifications on public.notifications;
create policy own_notifications on public.notifications for select to authenticated
  using (user_id = auth.uid() or (user_id is null and public.is_staff()));
drop policy if exists admin_notifications on public.notifications;
create policy admin_notifications on public.notifications for all to authenticated
  using (public.is_staff()) with check (public.is_staff());
drop policy if exists worker_mark_read on public.notifications;
create policy worker_mark_read on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- settings: admins read, super_admin writes
drop policy if exists admin_settings on public.settings;
create policy admin_settings on public.settings for select to authenticated using (public.is_staff());
drop policy if exists sa_settings on public.settings;
create policy sa_settings on public.settings for all to authenticated
  using (public.is_super_admin()) with check (public.is_super_admin());

-- ----------------------------------------------------------------------------
-- Default settings
-- ----------------------------------------------------------------------------
insert into public.settings (key, value) values
  ('general', '{"business_name":"CourierOps","currency":"PKR","low_stock_threshold":10}')
  on conflict (key) do nothing;
insert into public.settings (key, value) values
  ('flaship', '{"base_url":"https://partners.flaship.pk/api/integration","mode":"simulator","timeout_ms":15000,
    "endpoints":{"couriers":"/couriers","cities":"/cities","pickups":"/pickup-points","booking":"/orders","tracking":"/track"},
    "auto_sync_tracking":true}')
  on conflict (key) do nothing;
insert into public.settings (key, value) values
  ('commission', '{"default_rate":5,"deduct_on_return":true,"pay_on_delivery_only":true}')
  on conflict (key) do nothing;
