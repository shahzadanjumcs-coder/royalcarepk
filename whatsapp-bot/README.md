# RoyalCarePK — WhatsApp Bot (unofficial, WhatsApp Web automation)

Multi-account WhatsApp Web automation for RoyalCarePK order notifications.

```
RoyalCarePK (Vercel)  →  Supabase (orders / queue / commands)  →  THIS bot (your PC / always-on machine)
                                                                              →  WhatsApp Web
                                                                                    → customers, admins, Flaship group
```

> ⚠️ This is **NOT** the official Meta WhatsApp Cloud API. It automates WhatsApp Web
> through [Baileys](https://github.com/WhiskeySockets/Baileys). It must run on an
> always-on machine **you control** (your PC, a home server, a VPS) — never on
> Vercel serverless functions. WhatsApp may restrict accounts that send spam or
> bulk messages; this bot is deliberately limited to transactional notifications
> with conservative rate limiting, but **no unofficial approach can promise that
> an account will never be restricted.**

## What it does

| Notification | Recipient | Source event |
|---|---|---|
| BOOKED | customer | order status → `BOOKED` (after Flaship booking) |
| OUT FOR DELIVERY | customer | courier tracking shows `OUT_FOR_DELIVERY` |
| DELIVERED | customer | order status → `DELIVERED` |
| RETURNED | admin recipients (multiple) | order status → `RETURNED` |
| SHIPPER ADVISE | configured Flaship WhatsApp group(s) | courier shows `SHIPPER ADVISE` / `RETURN_TO_SHIPPER` |

Everything is configured in the RoyalCarePK admin panel (`/admin/whatsapp`):
accounts, routing (which number sends what), templates, admin recipients, the
Flaship group, pause/resume, failover, delays and retries.

## Installation

```bash
cd whatsapp-bot
npm install
cp .env.example .env      # then edit .env (see below)
npm test                  # optional: unit tests
```

### Environment variables (.env)

| Variable | Required | Meaning |
|---|---|---|
| `SUPABASE_URL` | yes | same Supabase project as RoyalCarePK |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | service role secret — **never** put it in the browser or Git |
| `WHATSAPP_SESSION_DIR` | no | session storage folder (default `./sessions`) |
| `WHATSAPP_POLL_MS` | no | poll interval for commands/queue (default 3000) |
| `WHATSAPP_SEND_DELAY_MS` | no | fallback delay between sends (default 2500; admin setting wins) |
| `WHATSAPP_RECONNECT_BASE_MS` | no | reconnect backoff base in ms (default 10000; doubles per attempt up to 5 min) |
| `PORT` | no | local health endpoint port (default 3088, `0` disables) |

### Start / stop

```bash
npm run start          # production
npm run dev            # auto-restart on file changes
```

Stop with `Ctrl+C` (sessions close cleanly and reconnect on next start).
Run continuously with pm2: `pm2 start src/index.js --name royalcare-whatsapp`

## Connecting WhatsApp numbers

1. **Add the number** — Admin panel → WhatsApp → Accounts → *Add WhatsApp Number*
   → give it a name (e.g. “Main WhatsApp”). The first number becomes the default sender.
2. **Connect** — press *Connect*. The bot starts an isolated session and a QR code
   appears in the panel (also printed in the bot terminal).
3. **Scan** — on that phone: WhatsApp → Settings → **Linked devices** → Link a device
   → scan. Status flips to **Connected** and the number is detected automatically.
4. **More numbers** — repeat for *Backup WhatsApp*, *Office WhatsApp*, *Customer Support*.
   Every account has its **own isolated session folder** (`sessions/<account_id>/`);
   connecting, disconnecting or logging out one number never touches another.
5. **Logout** unlinks the device (new QR scan needed next time). **Remove** deletes the
   account row and wipes its session files. **Reconnect** re-opens a session with the
   stored credentials (no QR needed unless the session expired or was logged out).

## Message routing

Admin panel → WhatsApp → *Routing & Templates*:

| Type | Sends to | Choose |
|---|---|---|
| BOOKED / OUT_FOR_DELIVERY / DELIVERED | customer phone on the order | sending account + fallback |
| RETURNED | every **enabled** admin recipient | sending account + fallback |
| SHIPPER ADVISE | every **enabled** Flaship group | sending account + fallback |

If no account is selected for a type, the **default** account is used. With
**failover** enabled, a disconnected primary falls back to the configured
fallback account (or any other connected account) — a message is only marked
`sent` after the sending session confirms delivery to WhatsApp.

## Flaship group

1. Add the bot's WhatsApp account (e.g. *Office WhatsApp*) to the Flaship group **as a member**.
2. Admin panel → WhatsApp → *Recipients & Groups* → **Fetch groups from bot** → pick the group.
3. Enable it. Test with the **Test Flaship Group** button (Test tab).

Messages are **only** sent to groups you configured here — never to random groups.

## Templates

Editable per notification type. Safe variables only, rendered by plain text
substitution (no code can execute): `{{customer_name}} {{order_number}}
{{cn_number}} {{courier}} {{status}} {{return_reason}} {{reason}}`.

## Reliability model

- **Queue** (`whatsapp_message_queue`): statuses `pending → processing → sent / retrying → failed / cancelled`.
- **Idempotency**: one notification per (`order`, `type`, `recipient`) via a UNIQUE
  `dedupe_key` — re-processed events can never double-send. `RETURNED` with 3 admin
  recipients creates 3 deduped rows.
- **Retries**: exponential backoff (30s → 1m → 2m…, capped at 10 min), bounded by
  *Max retries* (default 3). After that the row is `failed` with the reason, and an
  admin **Retry** button re-queues it manually.
- **Offline bot**: RoyalCarePK keeps working; notifications stay queued and are sent
  when the bot returns (queue is claimed oldest-first).
- **Pause/Resume**: *Pause Bot* stops all outgoing sends; queued messages are kept
  and processed after *Resume*.
- **Invalid numbers**: recorded once as `failed` with the reason — never retried in a loop.
- **Message Logs** tab: every attempt stored in `whatsapp_message_logs` (attempt #,
  status, account, error, timestamps).

## Security notes

- WhatsApp session credentials live **only** in `whatsapp-bot/sessions/` on this
  machine (add it to backups, never to Git or cloud sync).
- The Supabase service-role key lives **only** in this bot's `.env`.
- The admin panel never sees session data — only metadata (status, phone, QR image).
- All `/api/whatsapp/*` routes require the existing admin/super-admin login.
- Test messages are always prefixed `[RoyalCarePK TEST]`.

## Responsible use

Sequential sends, configurable delay (default 2.5s), bounded retries, no bulk
messaging features, no anti-detection tricks, no CAPTCHA handling, no scraping.
Keep the bot to legitimate RoyalCarePK transactional notifications.
