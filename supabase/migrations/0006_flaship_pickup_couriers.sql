-- 0006: Flaship pickup <-> courier mapping.
--
-- (Originally drafted as 0004; renumbered to 0006 because the remote main line
-- already uses 0004_whatsapp_bot.sql and 0005_whatsapp_inbox.sql.)
--
-- The official Integration API catalog (GET /catalog/) returns `companies[]`
-- where every courier entry carries the pickup locations enabled for it
-- (merchant_pickup_couriers on the Flaship side). Booking with a
-- (courierCompany, pickuplocation) pair that is NOT in this mapping fails with:
--   {"pickup_id":"Pickup is not synced to this courier
--     (missing merchant_pickup_couriers.external_ref)."}
-- We therefore persist the mapping at catalog-sync time so the booking UI can
-- offer only valid pairs and the booking service can guard the pair server-side.
--
-- Additive only: no existing table or column is modified.

create table if not exists public.flaship_pickup_couriers (
  id uuid primary key default gen_random_uuid(),
  pickup_id text not null,
  courier_id text not null,
  synced_at timestamptz,
  -- conflict target for the app's bulk upsert (store.upsertMany)
  unique (pickup_id, courier_id)
);

create index if not exists idx_flaship_pickup_couriers_courier
  on public.flaship_pickup_couriers (courier_id);

-- Same RLS posture as the other flaship catalog tables: staff have full access;
-- the server-side data layer runs with the service role (bypasses RLS).
alter table public.flaship_pickup_couriers enable row level security;

drop policy if exists staff_all on public.flaship_pickup_couriers;
create policy staff_all on public.flaship_pickup_couriers for all to authenticated
  using (public.is_staff()) with check (public.is_staff());
