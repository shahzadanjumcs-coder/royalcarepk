# CourierOps — Courier Business Management Platform

A production-ready web application for courier / e-commerce COD businesses: team & worker
management, order booking through the **Flaship** courier API, automatic worker **commission
ledger**, reservation-based **inventory**, payments, reports and a complete **admin dashboard** —
responsive from phone to desktop, installable as a PWA.

---

## 1. Project overview

| Capability | What you get |
|---|---|
| Team / Worker management | Workers, teams, assignments, worker codes, enable/disable, commission rates |
| Customer management | Auto-created or manual customers, order history, spending & return stats |
| Order management | Full lifecycle `CREATED → PENDING → ASSIGNED → BOOKED → IN_TRANSIT → DELIVERED / RETURNED / CANCELLED` with immutable status history |
| Flaship integration | Server-side booking, tracking sync, catalog sync (couriers / cities / pickup points), retry failed bookings, redacted request logs, duplicate-booking prevention |
| Inventory | Reservation model (`current`, `reserved`, `available`), stock in/out, adjustments, returns, full movement ledger, low-stock alerts |
| Commissions | Append-only ledger: `DELIVERED_COMMISSION`, `RETURN_ADJUSTMENT`, `MANUAL_ADJUSTMENT` — idempotent, rate snapshots locked per order |
| Worker payments | Cash / bank / other payments against net commission, over-payment protection |
| Reports | 12 reports (sales, orders, delivered, returned, worker performance/commission/payments, inventory, stock movement, product sales, customers) with date presets, CSV export, print view |
| Security | Supabase Auth, role-based API authorization, Row Level Security policies, audit logs, server-only API keys |
| Notifications | Admin feed (new orders, booking failures, low stock, returns, payments due) and worker feed (assignments, delivered/returned, commission credited, payments) |
| Audit trail | Logins, user/order/commission/payment/inventory/settings changes with before/after snapshots |

**Business rules enforced server-side**

1. Delivered → commission credited **once** (duplicate events ignored via unique partial index + checks)
2. Returned → credited amount deducted **once**, net = 0 (never negative unless manual)
3. Cancelled → no commission ever
4. Commission rate is **snapshotted on the order at assignment** — changing a worker's rate later never rewrites history
5. Worker balances are always **derived from the ledger** (net − paid = remaining) — never stored, never corruptible by payments
6. Creating an order **reserves** stock; delivering **finalizes** the deduction; returning (physically received) **restores** stock; cancelling releases the reservation
7. Flaship bookings are blocked once a booking id / CN exists on the order (no duplicates)
8. The Flaship API key lives **only on the server** — never in client bundles, logs are redacted

---

## 2. Tech stack

- **Next.js 16** (App Router) + **TypeScript** + **Tailwind CSS 4** + shadcn/ui
- **Supabase** — PostgreSQL, Auth, Row Level Security (live mode)
- **Zustand** for UI state, **Recharts** for charts, **zod** for validation
- Dual-mode data layer:
  - **LIVE mode** — real Supabase (env vars configured)
  - **DEMO mode** — embedded, JSON-persisted demo store + simulated Flaship API, so you can evaluate the entire product with zero external setup

---

## 3. Quick start (demo mode, no external accounts)

```bash
bun install          # or npm install
bun run dev          # http://localhost:3000
```

Sign in with the one-tap demo buttons on `/login`:

| Account | Email | Password |
|---|---|---|
| Super Admin | `admin@demo.com` | `admin123` |
| Admin / Manager | `manager@demo.com` | `admin123` |
| Worker | `ali@demo.com` | `worker123` |

Demo mode ships with ~60 days of seeded orders, commission ledgers, payments and inventory so
every dashboard, chart and report is populated. Data resets by deleting `data/demo-store.json`.

---

## 4. Supabase setup (live mode)

1. Create a free project at [supabase.com](https://supabase.com) (free tier is sufficient to start).
2. Open **SQL Editor** and run the whole of [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql).
   This creates every table, enum, index, RLS policy and helper trigger described below.
3. Copy `.env.local.example` → `.env.local` and fill in:

   ```env
   NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
   SUPABASE_SERVICE_ROLE_KEY=<service role key>
   DEMO_AUTH_SECRET=<long random string>
   ```

4. Restart the dev server. The app now uses Supabase Auth + Postgres.
5. **Create the first user**: sign up normally at `/signup`. The `handle_new_user` trigger makes the
   **very first profile a `super_admin`** automatically; subsequent signups are `worker` (promote
   them in Settings → Users). To promote manually:

   ```sql
   update public.profiles set role = 'admin' where email = 'you@example.com';
   ```

### Schema created by the migration

`profiles`, `teams`, `team_members`, `customers`, `categories`, `suppliers`, `products`,
`inventory_movements`, `orders`, `order_items`, `order_status_history`, `shipments`,
`shipment_tracking`, `commission_transactions`, `commission_rules`, `worker_payments`,
`flaship_couriers`, `flaship_cities`, `flaship_pickups`, `flaship_logs`, `notifications`,
`audit_logs`, `settings`.

Indexes on order status, worker, customer, tracking number, SKU and `created_at`; unique
constraints on SKU, barcode, phone, order number, CN, booking id and
`(order_id, type)` for idempotent commission entries.

### RLS model

- Staff roles (`super_admin`, `admin`) — full access to operational tables
- `inventory_manager` — manages inventory tables, reads orders
- `worker` — **select only** on: own profile, own orders + items + history + shipments + tracking, own
  commission transactions, own payments, own notifications
- `audit_logs` — insert by any authenticated app request, read by admins only
- `settings` / `flaship_logs` — admins only
- The server uses the service-role client for trusted writes; RLS protects any direct client access
  as defense-in-depth. Never disable RLS on `profiles`.

---

## 5. Seed data (live mode)

The SQL migration seeds only default settings. For demo data in live mode, run the app in demo
mode first, then either (a) export `data/demo-store.json` tables to SQL and insert them, or (b)
enter your real products/customers/workers via the UI — the app is fully usable from an empty
database. Never put real API keys or real customer data into seed files.

---

## 6. Environment variables

See [`.env.local.example`](.env.local.example). Summary:

| Variable | Where used | Required |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client + server (live mode) | for live mode |
| `SUPABASE_SERVICE_ROLE_KEY` | server only (user creation, trusted writes) | for live mode |
| `FLASHIP_API_BASE_URL` | server only | defaults to `https://partners.flaship.pk/api/integration` |
| `FLASHIP_API_KEY` | server only | live Flaship calls (absent ⇒ simulator) |
| `NEXT_PUBLIC_SITE_URL` | auth redirects | recommended |
| `DEMO_AUTH_SECRET` | server only | cookie signing in demo mode |

`.env*` files are git-ignored; never hardcode secrets.

---

## 7. Flaship API setup

1. Obtain your partner API key from Flaship.
2. Set `FLASHIP_API_KEY` (hosting env settings or `.env.local`).
3. Optionally adjust the endpoint paths in **Settings → Flaship API** (defaults:
   `GET /couriers`, `GET /cities`, `GET /pickup-points`, `POST /orders`, `GET /track/{cn}` —
   align them with the current Flaship integration documentation if it differs).
4. Use **Flaship → Couriers / Cities / Pickup Locations → Sync** to load the catalog.
5. Order flow: **Create order → assign worker → Book (Flaship) → CN saved → Sync tracking →
   Delivered/Returned**. Failed bookings show the API error on the order and in the booking
   console, and can be retried with one click.

Implementation notes: all calls run in server route handlers with `AbortController` timeouts
(15 s default), human-readable error mapping, and every request/response pair stored in
`flaship_logs` with API keys redacted. Without a key the built-in simulator produces realistic
bookings and tracking so you can test the whole flow.

---

## 8. Local development

```bash
bun install
bun run dev        # dev server on :3000 (auto-run by the sandbox)
bun run lint       # ESLint
bunx tsc --noEmit  # TypeScript check
```

Check `dev.log` for runtime errors. The sandbox preview is served through the platform gateway.

---

## 9. Production build & deployment

```bash
npm run build      # standalone output
npm start          # runs .next/standalone/server.js
```

### Free-tier deployment (Vercel)

1. Push the repo to GitHub.
2. Import into Vercel (free Hobby plan) — framework auto-detected.
3. Add all environment variables from the table above in **Project → Settings → Environment Variables**.
4. Deploy — you get `https://your-project.vercel.app` for free.
5. In Supabase **Auth → URL Configuration** set the site URL and add
   `https://your-project.vercel.app/**` to redirect URLs.

### Free-tier deployment (Cloudflare Pages)

Use `@opennextjs/cloudflare` or run the standalone Node build on a free container host
(Railway/Render/Fly free allowances). On Cloudflare Pages + Workers remember runtime limits:
keep Flaship timeouts ≤ 15 s and prefer Supabase RPCs for heavy aggregation as data grows.

### Honest free-tier notes (no false promises)

- **Supabase Free** — generous but limited (e.g. ~500 MB DB, projects pause after ~1 week of
  inactivity). Upgrade if you outgrow it.
- **Vercel Hobby** — for non-commercial/personal use per current terms; commercial usage may
  require Pro. Cloudflare has its own Workers free limits.
- **Flaship** — a third-party paid courier API; fees depend on your partner agreement. Nothing in
  this app adds paid services beyond what you already use.
- This project itself introduces **no paid dependencies** — everything runs on the stack above.

---

## 10. Security notes

- Role checks run **server-side on every API route** (`withAuth`), not just hidden UI
- Supabase RLS enforced in SQL for direct client access (worker isolation guaranteed at DB level)
- Flaship key: server env only; logs redact `Authorization`, `api_key` and Bearer tokens
- Sessions: Supabase Auth (live) or HMAC-signed httpOnly cookies (demo)
- All forms validated server-side with zod; raw DB errors are never shown to users
- `audit_logs` records actor, action, entity and before/after data for every important mutation

---

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| Login loops back to `/login` | Cookies blocked, or in live mode the profile row is missing/disabled — check `profiles` |
| "Flaship booking failed" | Check Settings → Flaship API logs; verify key + endpoint paths; use Retry |
| Commission not credited | Order must be **DELIVERED** with an assigned worker; check the ledger on the order page |
| Cannot create order (stock) | Available stock is lower than the requested quantity — record a Stock In first |
| Worker sees "no permission" | Workers can only access their own data by design; assign orders to them first |
| Demo data looks stale | Delete `data/demo-store.json` and restart to reseed |

---

## 12. Project layout

```
src/
  app/                    # routes (public, admin, worker) + API route handlers
    admin/…               # dashboard, orders, team, customers, inventory, flaship, accounts, reports, settings, audit
    worker/…              # worker dashboard, orders, earnings, payments, profile
    api/…                 # ~40 server route handlers (auth, orders, flaship, reports, …)
  components/app/         # app shell, sidebar, data-table, forms, states, charts
  lib/
    store/                # unified store API → supabase adapter | demo memory store + seed
    services/             # business logic (orders, commission, inventory, reports, …)
    flaship/              # server-only Flaship client (live + simulator) with redacted logs
    auth/                 # session, demo passwords, auth service
    api/                  # withAuth wrapper, helpers
supabase/migrations/      # full SQL schema + RLS + indexes
public/                   # PWA manifest + icons
```
