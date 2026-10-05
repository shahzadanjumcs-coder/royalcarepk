"use strict";
/**
 * Regression tests for the single-socket / single-timer reconnect invariant.
 *
 * Root cause they guard against: two+ live Baileys sockets sharing one auth
 * state make WhatsApp kill them with 440 connectionReplaced ("conflict"),
 * which used to feed an endless disconnect -> start -> disconnect loop.
 *
 * Baileys is replaced with a controllable fake (require.cache injection
 * BEFORE accounts.js loads) so slow starts, late close events and overlapping
 * reconnect schedules can be simulated deterministically. The env knob
 * WHATSAPP_RECONNECT_BASE_MS is read at require time and set to 60ms here.
 */

process.env.WHATSAPP_RECONNECT_BASE_MS = "60";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

// ---------- fake Baileys (must be injected before ../src/accounts loads) ----------
const createdSockets = [];
let authStateDelayMs = 0;

function makeFakeSock() {
  const sock = new EventEmitter();
  sock.ev = new EventEmitter();
  sock.user = null;
  sock.closed = false;
  sock.end = function end() {
    this.closed = true;
  };
  sock.logout = async () => {};
  sock.sendMessage = async () => ({ key: { id: "fake" } });
  sock.groupFetchAllParticipating = async () => ({});
  return sock;
}

const baileysPath = require.resolve("@whiskeysockets/baileys");
require.cache[baileysPath] = {
  id: baileysPath,
  filename: baileysPath,
  loaded: true,
  exports: {
    default: function fakeMakeWASocket() {
      const sock = makeFakeSock();
      createdSockets.push(sock);
      return sock;
    },
    useMultiFileAuthState: async () => {
      if (authStateDelayMs > 0) await new Promise((r) => setTimeout(r, authStateDelayMs));
      return { state: { creds: {}, keys: {} }, saveCreds: async () => {} };
    },
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1023223821] }),
    makeCacheableSignalKeyStore: (keys) => keys,
    disconnectSocket: () => {},
    Browsers: { ubuntu: (b) => `Ubuntu (${b})` },
    DisconnectReason: {
      connectionClosed: 428,
      connectionLost: 408,
      connectionReplaced: 440,
      timedOut: 408,
      loggedOut: 401,
      badSession: 500,
      restartRequired: 515,
      multideviceMismatch: 411,
      forbidden: 403,
      unavailableService: 503,
    },
  },
};

const { AccountManager } = require("../src/accounts");

// ---------- helpers ----------
const ACCOUNT = { id: "acc-race", name: "Royalcarepk", enabled: true };

function makeFakeSb() {
  return {
    from(table) {
      const result = { data: table === "whatsapp_accounts" ? { ...ACCOUNT } : null, error: null };
      const api = {
        select: () => api,
        eq: () => api,
        order: () => api,
        limit: () => api,
        in: () => api,
        lte: () => api,
        update: () => api,
        insert: () => api,
        maybeSingle: () => Promise.resolve(result),
        single: () => Promise.resolve(result),
        then: (res, rej) => Promise.resolve(result).then(res, rej),
        catch: (rej) => Promise.resolve(result).catch(rej),
      };
      return api;
    },
  };
}

function freshManager() {
  createdSockets.length = 0;
  authStateDelayMs = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rcbot-race-"));
  return { mgr: new AccountManager(makeFakeSb(), dir), dir };
}

function boom(message, statusCode) {
  return Object.assign(new Error(message), { output: { statusCode } });
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- tests ----------
test("concurrent start/ensureStarted/startNow calls create exactly ONE socket", async () => {
  const { mgr } = freshManager();
  authStateDelayMs = 60; // hold the start window open — every caller lands inside it
  await Promise.all([mgr.ensureStarted(ACCOUNT), mgr.ensureStarted(ACCOUNT), mgr.start(ACCOUNT, 0), mgr.startNow(ACCOUNT)]);

  assert.strictEqual(createdSockets.length, 1, "only one socket may ever be created");
  const entry = mgr.socks.get(ACCOUNT.id);
  assert.ok(entry?.sock, "entry holds the live socket");
  assert.strictEqual(entry.starting, false);
  assert.ok(!entry.reconnectTimer);
});

test("stale socket close event is ignored, ends the stale socket, schedules nothing", async () => {
  const { mgr } = freshManager();
  await mgr.start(ACCOUNT);
  const sockA = createdSockets[0];

  // a newer socket takes ownership of the entry
  const sockB = makeFakeSock();
  mgr.socks.set(ACCOUNT.id, { sock: sockB, reconnectTimer: null, reconnectAttempt: 0, starting: false });

  // socket A's late 440 conflict close arrives via its own listener
  sockA.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: boom("conflict", 440) } });
  await settle(20);

  assert.ok(sockA.closed, "stale socket must be ended so WhatsApp sees one connection");
  const entry = mgr.socks.get(ACCOUNT.id);
  assert.strictEqual(entry.sock, sockB, "current socket entry survives");
  assert.ok(!entry.reconnectTimer, "no reconnect may be scheduled from a stale event");
  assert.strictEqual(createdSockets.length, 1, "no new socket may be started");
});

test("scheduleReconnect never overlaps: second call is a no-op and the timer fires exactly once", async () => {
  const { mgr } = freshManager();
  await mgr.scheduleReconnect(ACCOUNT.id);
  const first = mgr.socks.get(ACCOUNT.id);
  assert.ok(first?.reconnectTimer, "timer scheduled");
  assert.strictEqual(first.reconnectAttempt, 1);

  await mgr.scheduleReconnect(ACCOUNT.id); // must NOT stack a second timer
  assert.strictEqual(mgr.socks.get(ACCOUNT.id), first, "entry untouched by the second call");

  await mgr.ensureStarted(ACCOUNT); // reconcile must not start while a reconnect is pending
  assert.strictEqual(createdSockets.length, 0);

  await settle(1300); // base 60ms + jitter up to ~1060ms
  assert.strictEqual(createdSockets.length, 1, "exactly one socket after the single timer fired");
  const entry = mgr.socks.get(ACCOUNT.id);
  assert.ok(entry?.sock, "socket live after the timer fired");
  assert.ok(!entry.reconnectTimer && !entry.starting);
});

test("reconnect backoff attempt grows across drops (was stuck at a constant ~10s)", async () => {
  const { mgr } = freshManager();
  await mgr.start(ACCOUNT);
  const sock = createdSockets[0];
  mgr.socks.get(ACCOUNT.id).reconnectAttempt = 3; // this socket was the 3rd reconnect generation

  await mgr.onConnectionUpdate(ACCOUNT.id, sock, {
    connection: "close",
    lastDisconnect: { error: boom("connection closed", 428) },
  });

  const entry = mgr.socks.get(ACCOUNT.id);
  assert.strictEqual(entry?.reconnectAttempt, 4, "attempt carries over and grows");
  assert.ok(entry?.reconnectTimer, "reconnect scheduled");
  clearTimeout(entry.reconnectTimer);
  mgr.socks.delete(ACCOUNT.id);
});

test("loggedOut (401) still wipes the session and schedules nothing", async () => {
  const { mgr, dir } = freshManager();
  assert.ok(dir.startsWith(os.tmpdir()));
  await mgr.start(ACCOUNT);
  const sock = createdSockets[0];
  const authDir = mgr.authDir(ACCOUNT.id);
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(path.join(authDir, "creds.json"), "{}");

  await mgr.onConnectionUpdate(ACCOUNT.id, sock, {
    connection: "close",
    lastDisconnect: { error: boom("Stream Errored (unauthorized)", 401) },
  });

  assert.strictEqual(mgr.socks.has(ACCOUNT.id), false);
  assert.strictEqual(fs.existsSync(authDir), false, "session files wiped only on a real logout");
});

test("startNow supersedes a pending reconnect timer (manual connect is immediate)", async () => {
  const { mgr } = freshManager();
  await mgr.scheduleReconnect(ACCOUNT.id); // timer pending (~60ms + jitter)
  await mgr.startNow(ACCOUNT); // must not wait for the timer

  assert.strictEqual(createdSockets.length, 1, "socket started immediately");
  const entry = mgr.socks.get(ACCOUNT.id);
  assert.ok(entry?.sock);

  await settle(1300); // wait past the original timer deadline
  assert.strictEqual(createdSockets.length, 1, "superseded timer never fires a second socket");
});

test("stop() during an in-flight start prevents the socket from being created", async () => {
  const { mgr } = freshManager();
  authStateDelayMs = 80;
  const starting = mgr.start(ACCOUNT);
  await settle(10); // we are now inside the auth-state await
  mgr.stop(ACCOUNT.id);
  await starting;

  assert.strictEqual(createdSockets.length, 0, "no socket may be created after stop");
  assert.strictEqual(mgr.socks.has(ACCOUNT.id), false);
});
