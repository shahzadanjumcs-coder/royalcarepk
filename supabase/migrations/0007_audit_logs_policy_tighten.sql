-- 0007: Security hardening — audit_logs insert policy.
--
-- Problem: 0001 created `insert_audit ... to authenticated with check (true)`.
-- The browser session is a cookie-bound ANON-KEY client (src/lib/supabase/
-- server.ts, used by src/lib/auth/service.ts sign-in), so every signed-in
-- user's JWT could INSERT forged rows into public.audit_logs directly via the
-- Supabase REST API, bypassing the app. Audit logs are the integrity trail of
-- record for destructive admin actions and must be app-written only.
--
-- Fix: drop the policy. All legitimate audit writes go through the
-- service-role store (src/lib/store, SUPABASE_SERVICE_ROLE_KEY), which
-- bypasses RLS entirely, so app behavior is unchanged. Authenticated anon-key
-- sessions can no longer insert (and never could update/delete — no such
-- policies exist).
--
-- Additive only: no table, column or app-facing behavior is modified.

drop policy if exists insert_audit on public.audit_logs;
