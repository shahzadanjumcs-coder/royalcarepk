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

const pino = require("pino");
const QRCode = require("qrcode");
const qrcodeTerminal = require("qrcode-terminal");
const { updateAccount } = require("./store");

const logger = pino({ level: "error" });
const RECONNECT_BASE_MS = 10 * 1000;
const RECONNECT_MAX_MS = 5 * 60 * 1000;

class AccountManager {
  constructor(sb, sessionDir) {
    this.sb = sb;
    this.sessionDir = sessionDir;
    /** accountId -> { sock, reconnectTimer, reconnectAttempt } */
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

  /** Start a socket for an account if one is not already running. */
  async ensureStarted(account) {
    if (this.socks.has(account.id)) return;
    await this.start(account);
  }

  async start(account, attempt = 0) {
    if (this.socks.has(account.id)) return;
    fs.mkdirSync(this.authDir(account.id), { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir(account.id));
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      version = undefined; // offline fallback — Baileys uses its baked-in default
    }

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

    this.socks.set(account.id, { sock, reconnectTimer: null, reconnectAttempt: attempt });
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", (update) => {
      this.onConnectionUpdate(account.id, sock, update).catch((e) => console.error("[bot] connection.update handler:", e.message));
    });

    console.log(`[bot] starting session for "${account.name}" (${account.id})`);
  }

  async onConnectionUpdate(accountId, sock, update) {
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
      const entry = this.socks.get(accountId);
      if (entry) entry.reconnectAttempt = 0;
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

      await updateAccount(this.sb, accountId, {
        status: "disconnected",
        last_disconnected_at: new Date().toISOString(),
        last_error: `Connection closed (code ${statusCode ?? "unknown"}) — will retry.`,
      });
      await this.scheduleReconnect(accountId);
    }
  }

  async scheduleReconnect(accountId) {
    // re-read the row: a disabled/removed account must NOT reconnect
    const { data } = await this.sb.from("whatsapp_accounts").select("*").eq("id", accountId).maybeSingle();
    if (!data || !data.enabled) return;
    const entry = this.socks.get(accountId);
    const attempt = (entry?.reconnectAttempt ?? 0) + 1;
    const delay = Math.min(RECONNECT_BASE_MS * attempt, RECONNECT_MAX_MS);
    console.log(`[bot] reconnecting account ${accountId} in ${Math.round(delay / 1000)}s (attempt ${attempt})`);
    const timer = setTimeout(async () => {
      this.socks.delete(accountId);
      try {
        await this.start(data, attempt);
      } catch (e) {
        console.error(`[bot] reconnect failed for ${accountId}:`, e.message);
      }
    }, delay);
    this.socks.set(accountId, { sock: null, reconnectTimer: timer, reconnectAttempt: attempt });
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
      if (account.enabled && !this.socks.has(account.id)) {
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
