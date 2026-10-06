"use strict";
/**
 * Multi-account WhatsApp Web session manager (Baileys).
 *
 * Isolation rules:
 *  - every account id gets its OWN auth folder under sessions/<account_id>/
 *  - starting/stopping/logging out one account never touches another
 *  - session credentials stay on this machine and are never uploaded anywhere
 *
 * Account rows in Supabase hold metadata only (status, phone, QR data URL,
 * last errors). The QR code is stored as a data URL so the admin panel can
 * render it without exposing any session credential.
 */

const fs = require("node:fs");
const path = require("node:path");

const baileys = require("@whiskeysockets/baileys");
const makeWASocket = baileys.default ?? baileys;
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  disconnectSocket,
  Browsers,
  DisconnectReason,
} = baileys;

const QRCode = require("qrcode");
const qrcodeTerminal = require("qrcode-terminal");
const { updateAccount, writeInboxMessage } = require("./store");
const { isTransientBaileysError, parseIncomingMessage } = require("./lib");
const { createBotLogger } = require("./logger");

// Deduped Baileys logger: transient internal errors (e.g. "unexpected error
// in 'init queries'" with statusCode 408 on slow networks) are non-fatal —
// the first occurrence is logged, identical repeats collapse for 10 minutes.
const logger = createBotLogger("error");
// Reconnect backoff base. WHATSAPP_RECONNECT_BASE_MS exists mainly for tests;
// production default stays 10s.
const RECONNECT_BASE_MS = Number(process.env.WHATSAPP_RECONNECT_BASE_MS) || 10 * 1000;
const RECONNECT_MAX_MS = 5 * 60 * 1000;

class AccountManager {
  constructor(sb, sessionDir) {
    this.sb = sb;
    this.sessionDir = sessionDir;
    /** accountId -> { sock, reconnectTimer, reconnectAttempt, starting } */
    this.socks = new Map();
  }

  authDir(accountId) {
    return path.join(this.sessionDir, accountId);
  }

  isConnected(accountId) {
    const entry = this.socks.get(accountId);
    return !!entry && entry.sock?.user != null;
  }

  getConnected(accountId) {
    return this.isConnected(accountId) ? this.socks.get(accountId).sock : null;
  }

  /**
   * Start a socket for an account unless one is already live, mid-start, or
   * waiting on a reconnect timer. Conservative on purpose: reconcile() calls
   * this every 15s, so it must never defeat a pending reconnect backoff.
   */
  async ensureStarted(account) {
    const entry = this.socks.get(account.id);
    if (entry?.sock || entry?.starting || entry?.reconnectTimer) return;
    await this.start(account);
  }

  /**
   * Explicit user-driven start (admin "connect" command): supersedes any
   * pending reconnect timer so a manual click always takes effect now.
   */
  async startNow(account) {
    const entry = this.socks.get(account.id);
    if (entry?.sock || entry?.starting) return;
    await this.start(account);
  }

  /**
   * SINGLE-SOCKET INVARIANT: at most ONE Baileys socket per WhatsApp account,
   * and at most ONE in-flight start() / pending reconnect timer per account.
   * Two live sockets sharing one auth state make WhatsApp kill them with
   * 440 connectionReplaced ("conflict") in an endless reconnect loop.
   */
  async start(account, attempt = 0) {
    const existing = this.socks.get(account.id);
    if (existing?.starting) return; // a start is already in flight — never fork a second one
    if (existing?.sock) return; // a live socket already exists
    if (existing?.reconnectTimer) clearTimeout(existing.reconnectTimer); // a fresh start supersedes any pending timer

    this.socks.set(account.id, { sock: null, reconnectTimer: null, reconnectAttempt: attempt, starting: true });
    try {
      fs.mkdirSync(this.authDir(account.id), { recursive: true });

      const { state, saveCreds } = await useMultiFileAuthState(this.authDir(account.id));
      let version;
      try {
        ({ version } = await fetchLatestBaileysVersion());
      } catch {
        version = undefined; // offline fallback — Baileys uses its baked-in default
      }

      // Re-check after the awaits above: stop()/logout() may have removed the
      // placeholder while we were reading auth state / fetching the version.
      const current = this.socks.get(account.id);
      if (!current || !current.starting) return;

      const sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger,
        printQRInTerminal: false,
        browser: Browsers.ubuntu("Chrome"),
        markOnlineOnConnect: false,
        syncFullHistory: false,
      });

      this.socks.set(account.id, { sock, reconnectTimer: null, reconnectAttempt: attempt, starting: false });

      sock.ev.on("creds.update", saveCreds);
      // Incoming message capture. Fire-and-forget by design: parsing or DB
      // failures here are logged and swallowed — they must NEVER throw into
      // the socket, crash the bot or disturb the WhatsApp session. Only
      // "notify" (real-time) events are logged; "append" is history sync
      // which would flood the inbox with old messages after every reconnect.
      sock.ev.on("messages.upsert", ({ messages, type }) => {
        const live = this.socks.get(account.id);
        if (!live || live.sock !== sock) return; // stale event from a superseded socket
        if (type !== "notify" || !Array.isArray(messages)) return;
        for (const m of messages) {
          try {
            const row = parseIncomingMessage(account.id, m);
            if (!row) continue; // fromMe echo / status@broadcast / protocol noise
            writeInboxMessage(this.sb, row)
              .then(() => console.log(`[bot] inbox: stored message from ${row.sender_phone ?? row.chat_jid}${row.sender_name ? ` (${row.sender_name})` : ""}`))
              .catch((e) => console.error("[bot] inbox write error:", e.message));
          } catch (e) {
            console.error("[bot] inbox parse error:", e.message);
          }
        }
      });
      sock.ev.on("connection.update", (update) => {
        const entry = this.socks.get(account.id);
        if (!entry || entry.sock !== sock) {
          // Stale event from a superseded socket: ignore it AND make sure that
          // socket is really dead so WhatsApp never sees two live connections.
          try {
            sock.end(new Error("superseded by a newer session for this account"));
          } catch {
            /* already closed */
          }
          return;
        }
        this.onConnectionUpdate(account.id, sock, update).catch((e) => console.error("[bot] connection.update handler:", e.message));
      });

      console.log(`[bot] starting session for "${account.name}" (${account.id})`);
    } catch (e) {
      const entry = this.socks.get(account.id);
      if (entry && entry.starting && !entry.sock) this.socks.delete(account.id);
      throw e;
    }
  }

  async onConnectionUpdate(accountId, sock, update) {
    // Stale-socket guard: only the socket that currently owns the map entry
    // may drive account state. Events from replaced/old sockets are ignored
    // (the ev wrapper in start() also ends those sockets).
    const entry = this.socks.get(accountId);
    if (!entry || entry.sock !== sock) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 512 });
      qrcodeTerminal.generate(qr, { small: true });
      await updateAccount(this.sb, accountId, {
        status: "connecting",
        qr_code: dataUrl,
        qr_updated_at: new Date().toISOString(),
      });
      console.log(`[bot] QR generated for account ${accountId} — scan it from the admin panel or the terminal`);
      return;
    }

    if (connection === "connecting") {
      await updateAccount(this.sb, accountId, { status: "connecting" });
      return;
    }

    if (connection === "open") {
      entry.reconnectAttempt = 0;
      const jid = sock.user?.id ?? "";
      const phone = String(jid.split("@")[0] || "").replace(/:[0-9]+$/, "");
      await updateAccount(this.sb, accountId, {
        status: "connected",
        phone,
        qr_code: null,
        qr_updated_at: null,
        last_connected_at: new Date().toISOString(),
        last_error: null,
        last_seen_at: new Date().toISOString(),
      });
      console.log(`[bot] account ${accountId} CONNECTED as ${phone}`);
      return;
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      // Read this socket's attempt BEFORE dropping the entry — deleting first
      // used to reset the backoff to attempt 1 (a constant ~10s) on every drop.
      const attemptSoFar = entry.reconnectAttempt ?? 0;
      if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
      this.socks.delete(accountId);
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        // session unlinked from the phone — wipe it, a new QR scan is required
        this.wipeSessionFiles(accountId);
        await updateAccount(this.sb, accountId, {
          status: "disconnected",
          qr_code: null,
          qr_updated_at: null,
          last_disconnected_at: new Date().toISOString(),
          last_error: "Logged out from the phone — scan a new QR to connect again.",
        });
        console.log(`[bot] account ${accountId} logged out — session wiped`);
        return;
      }

      // A transient drop (408 timed out, 428 closed, 515 restart…) never
      // invalidates the stored session — only loggedOut (401) wipes it.
      const transient = isTransientBaileysError(lastDisconnect?.error);
      await updateAccount(this.sb, accountId, {
        status: "disconnected",
        last_disconnected_at: new Date().toISOString(),
        last_error: transient
          ? `Transient WhatsApp network issue (code ${statusCode ?? "unknown"}) — reconnecting automatically; session preserved.`
          : `Connection closed (code ${statusCode ?? "unknown"}) — will retry.`,
      });
      console.log(
        `[bot] account ${accountId} disconnected (code ${statusCode ?? "unknown"}${transient ? ", transient" : ""}) — session files kept, reconnecting with backoff`
      );
      await this.scheduleReconnect(accountId, attemptSoFar);
    }
  }

  async scheduleReconnect(accountId, attemptHint = null) {
    // re-read the row: a disabled/removed account must NOT reconnect
    const { data } = await this.sb.from("whatsapp_accounts").select("*").eq("id", accountId).maybeSingle();
    if (!data || !data.enabled) return;
    const existing = this.socks.get(accountId);
    // SINGLE-TIMER GUARD: a socket may have been started (reconcile/command)
    // or another reconnect scheduled while we awaited above — never overlap.
    if (existing?.sock || existing?.starting || existing?.reconnectTimer) return;
    const attempt = (attemptHint ?? existing?.reconnectAttempt ?? 0) + 1;
    // exponential backoff + small jitter: 10s, 20s, 40s, 80s … capped at 5min
    const exponential = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt - 1), RECONNECT_MAX_MS);
    const delay = Math.round(exponential + Math.random() * 1000);
    console.log(`[bot] reconnecting account ${accountId} in ${Math.round(delay / 1000)}s (attempt ${attempt})`);
    const timer = setTimeout(() => {
      // Fire only if this exact timer is still the scheduled one — a start(),
      // stop() or newer scheduleReconnect() must never be double-fired.
      const entry = this.socks.get(accountId);
      if (!entry || entry.reconnectTimer !== timer) return;
      this.socks.delete(accountId);
      this.start(data, attempt).catch((e) => {
        console.error(`[bot] reconnect failed for ${accountId}:`, e.message);
        // keep the backoff growing across persistent start failures
        this.scheduleReconnect(accountId, attempt).catch(() => {});
      });
    }, delay);
    this.socks.set(accountId, { sock: null, reconnectTimer: timer, reconnectAttempt: attempt, starting: false });
  }

  /** Graceful stop (keeps session files so the next start re-uses them). */
  stop(accountId) {
    const entry = this.socks.get(accountId);
    if (!entry) return;
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    try {
      entry.sock?.end(new Error("stopped by bot"));
    } catch {
      /* already closed */
    }
    this.socks.delete(accountId);
    console.log(`[bot] session stopped for ${accountId}`);
  }

  /** Logout = unlink the device on WhatsApp's side, then wipe local files. */
  async logout(accountId) {
    const entry = this.socks.get(accountId);
    const sock = entry?.sock;
    if (sock) {
      try {
        await sock.logout();
      } catch (e) {
        console.error(`[bot] logout error for ${accountId}:`, e.message);
      }
      try {
        sock.end(new Error("logged out"));
      } catch {
        /* ignore */
      }
    }
    this.socks.delete(accountId);
    this.wipeSessionFiles(accountId);
    await updateAccount(this.sb, accountId, {
      status: "disconnected",
      qr_code: null,
      qr_updated_at: null,
      last_disconnected_at: new Date().toISOString(),
    });
  }

  /** Remove = stop + delete the account's isolated session folder. */
  remove(accountId) {
    this.stop(accountId);
    this.wipeSessionFiles(accountId);
  }

  wipeSessionFiles(accountId) {
    try {
      fs.rmSync(this.authDir(accountId), { recursive: true, force: true });
    } catch (e) {
      console.error(`[bot] could not wipe session files for ${accountId}:`, e.message);
    }
  }

  /**
   * Reconcile local sockets with the accounts table:
   *  - start enabled accounts that have no socket (fresh connect or reconnect)
   *  - stop sockets whose account got disabled or removed
   */
  async reconcile() {
    const { data: accounts, error } = await this.sb.from("whatsapp_accounts").select("*");
    if (error) throw error;
    const rows = accounts ?? [];
    const ids = new Set(rows.map((r) => r.id));

    for (const account of rows) {
      // ensureStarted() itself skips accounts that are live, mid-start, or
      // waiting on a reconnect timer — calling it unconditionally also heals
      // any stale placeholder entries.
      if (account.enabled) {
        try {
          await this.ensureStarted(account);
        } catch (e) {
          console.error(`[bot] could not start "${account.name}":`, e.message);
          await updateAccount(this.sb, account.id, { last_error: `Bot could not start session: ${e.message}` });
        }
      }
      if (!account.enabled && this.socks.has(account.id)) {
        this.stop(account.id);
        await updateAccount(this.sb, account.id, { status: "disconnected", qr_code: null });
      }
    }

    // rows deleted while a socket was live
    for (const accountId of [...this.socks.keys()]) {
      if (!ids.has(accountId)) {
        this.stop(accountId);
        this.wipeSessionFiles(accountId);
      }
    }
  }

  /** Heartbeat: last_seen_at per connected account. */
  async heartbeat() {
    const now = new Date().toISOString();
    for (const accountId of this.socks.keys()) {
      if (this.isConnected(accountId)) {
        await updateAccount(this.sb, accountId, { last_seen_at: now });
      }
    }
  }

  /** List joined groups for the group-picker dialog (no random sends). */
  async listGroups(accountId) {
    const sock = this.getConnected(accountId);
    if (!sock) throw new Error("That account is not connected.");
    const groups = await sock.groupFetchAllParticipating();
    return Object.values(groups ?? {}).map((g) => ({ id: g.id, name: g.subject }));
  }

  async sendText(accountId, jid, text) {
    const sock = this.getConnected(accountId);
    if (!sock) throw new Error("Account is not connected.");
    const result = await sock.sendMessage(jid, { text });
    // only a resolved Baileys promise counts as "sent"
    return !!result;
  }

  async shutdown() {
    for (const accountId of [...this.socks.keys()]) {
      this.stop(accountId);
    }
    try {
      disconnectSocket?.();
    } catch {
      /* ignore */
    }
  }
}

module.exports = { AccountManager };
