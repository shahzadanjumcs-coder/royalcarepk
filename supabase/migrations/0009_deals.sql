-- 0009: Deals / bundles.
--
-- A deal combines existing products into a sellable bundle with one
-- promotional selling price. Orders reference deals through order_items
-- rows (deal_id + order-time snapshots), and the bundle's components are
-- expanded into the normal inventory lifecycle (reserve on create, deduct
-- on delivery, release on cancel, restore on return).
--
-- Additive only: no existing table or column is modified or dropped.

create table if not exists public.deals (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  -- promotional price for the WHOLE bundle (kept separate from component
  -- catalogue prices; the customer is charged this price)
  selling_price numeric(12,2) not null check (selling_price >= 0),
  -- active = selectable on order forms; inactive = hidden but editable;
  -- archived = retired (kept for historical reference)
  status text not null default 'active' check (status in ('active','inactive','archived')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_deals_status on public.deals (status);

create table if not exists public.deal_items (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  quantity integer not null check (quantity > 0),
  unique (deal_id, product_id)
);

create index if not exists idx_deal_items_deal on public.deal_items (deal_id);

-- Order-time deal snapshot columns on order_items (additive):
--   deal_id    — which deal produced this line (SET NULL on deal delete;
--                the snapshots below keep the historical line intact)
--   components — jsonb snapshot [{ product_id, name, quantity }] of the
--                bundle's product requirements AT ORDER TIME, so later deal
--                edits never rewrite historical orders and the inventory
--                lifecycle can expand the bundle exactly as it was sold.
alter table public.order_items
  add column if not exists deal_id uuid references public.deals(id) on delete set null,
  add column if not exists components jsonb;

create index if not exists idx_order_items_deal on public.order_items (deal_id);

-- Same RLS posture as the other staff tables: staff have full access; the
-- server-side data layer runs with the service role (bypasses RLS).
alter table public.deals enable row level security;
alter table public.deal_items enable row level security;

drop policy if exists staff_all on public.deals;
create policy staff_all on public.deals for all to authenticated
  using (public.is_staff()) with check (public.is_staff());

drop policy if exists staff_all on public.deal_items;
create policy staff_all on public.deal_items for all to authenticated
  using (public.is_staff()) with check (public.is_staff());
