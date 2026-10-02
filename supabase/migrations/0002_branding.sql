-- ============================================================================
-- RoyalCarePK — Migration 0002: Branding system, storage bucket, access fixes
-- Idempotent: safe to run on an existing 0001-initialized database.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Supabase Storage bucket for branding assets (public read)
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'branding', 'branding', true, 524288,
  array['image/png','image/jpeg','image/webp','image/svg+xml','image/x-icon','image/vnd.microsoft.icon']
)
on conflict (id) do update
  set public = true,
      file_size_limit = 524288,
      allowed_mime_types = excluded.allowed_mime_types;

-- Public read of branding assets (logos/favicon must render on the login page)
drop policy if exists "public read branding" on storage.objects;
create policy "public read branding" on storage.objects
  for select using (bucket_id = 'branding');

-- Only Super Admins / Admins may upload, replace or remove branding assets
drop policy if exists "staff upload branding" on storage.objects;
create policy "staff upload branding" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'branding'
    and public.current_profile_role() in ('super_admin','admin')
  );

drop policy if exists "staff update branding" on storage.objects;
create policy "staff update branding" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'branding'
    and public.current_profile_role() in ('super_admin','admin')
  );

drop policy if exists "staff delete branding" on storage.objects;
create policy "staff delete branding" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'branding'
    and public.current_profile_role() in ('super_admin','admin')
  );

-- ----------------------------------------------------------------------------
-- 2. Settings access: staff can read, super admins write,
--    and the public must be able to read the branding row (login page).
-- ----------------------------------------------------------------------------
drop policy if exists sa_settings on public.settings;
drop policy if exists sa_settings_read on public.settings;
drop policy if exists sa_settings_write on public.settings;

create policy sa_settings_read on public.settings for select to authenticated
  using (public.is_staff() or key = 'branding');

create policy sa_settings_write on public.settings for all to authenticated
  using (public.is_super_admin()) with check (public.is_super_admin());

-- ----------------------------------------------------------------------------
-- 3. Designated Super Admin: royalcarepk@gmail.com
--    (no password is stored in code — the password is configured securely
--    through Supabase Auth when the account is created/invited)
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
    case
      when lower(new.email) = 'royalcarepk@gmail.com' then 'super_admin'::public.user_role
      when first_user then 'super_admin'::public.user_role
      else 'worker'::public.user_role
    end,
    case when first_user or lower(new.email) = 'royalcarepk@gmail.com' then null
         else 'W-' || lpad((floor(random()*9000)+1000)::text, 4, '0') end,
    case when first_user or lower(new.email) = 'royalcarepk@gmail.com' then 0 else 5 end
  );
  return new;
end;
$$;

-- Promote the designated owner if the account already exists
update public.profiles
set role = 'super_admin', worker_code = null, commission_rate = 0
where lower(email) = 'royalcarepk@gmail.com' and role <> 'super_admin';

-- ----------------------------------------------------------------------------
-- 4. Default branding + refreshed Flaship endpoint defaults
-- ----------------------------------------------------------------------------
insert into public.settings (key, value) values
  ('branding', '{"brand_name":"RoyalCarePK","tagline":"Business Console","logo_url":null,"mobile_logo_url":null,"favicon_url":null,"primary_color":"#10b981","secondary_color":"#0f172a"}')
  on conflict (key) do nothing;

insert into public.settings (key, value) values
  ('general', '{"business_name":"RoyalCarePK","currency":"PKR","low_stock_threshold":10}')
  on conflict (key) do update
    set value = public.settings.value
    where public.settings.value->>'business_name' in ('CourierOps','CourierOps Traders');

update public.settings
set value = jsonb_set(
      jsonb_set(
        jsonb_set(value, '{endpoints,catalog}', '"\/catalog\/"'),
        '{endpoints,bookings}', '"\/bookings\/"'),
      '{endpoints,tracking}', '"\/orders\/{cn}\/tracking\/"')
    || '{"default_service_type":"overnight","default_weight":0.5,"timeout_ms":30000}'::jsonb
where key = 'flaship'
  and value->'endpoints' ? 'couriers';
