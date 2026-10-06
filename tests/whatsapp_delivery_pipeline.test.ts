/// <reference types="bun-types" />
/**
 * WhatsApp delivery pipeline — app-side guards and evidence fields.
 *
 * Covers:
 * - GET /api/whatsapp/accounts returns a server-computed session_live flag
 *   (DB status "connected" + fresh bot heartbeat) so a dead bot can never be
 *   shown as a usable connected session
 * - POST /api/whatsapp/test refuses with an explicit offline error when the
 *   bot heartbeat is stale, and refuses stale sessions, instead of pretending
 *   a test message will be sent
 * - isBotOnline / isAccountSessionLive unit behavior (90s freshness window)
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";

type SessionShape = { role: string; userId: string; name?: string } | null;
let mockSession: SessionShape = { role: "super_admin", userId: "u-super", name: "Super" };
mock.module("server-only", () => ({}));
mock.module("@/lib/auth/session", () => ({ getSession: async () => mockSession }));

const now = Date.now();
const FRESH = new Date(now - 10 * 1000).toISOString(); // 10s ago — live
const STALE = new Date(now - 30 * 60 * 1000).toISOString(); // 30min ago — dead

const db: Record<string, Record<string, unknown>[]> = {
  whatsapp_accounts: [],
  whatsapp_bot_settings: [],
  whatsapp_commands: [],
};
let insertedCommands: { table: string; payload: Record<string, unknown> }[] = [];

function resetDb() {
  db.whatsapp_accounts = [
    {
      id: "acc-live",
      name: "Main",
      phone: "923001234567",
      status: "connected",
      enabled: true,
      is_default: true,
      last_seen_at: FRESH,
    },
    {
      id: "acc-stale",
      name: "Stale",
      phone: "923009999999",
      status: "connected", // DB claims connected…
      enabled: true,
      is_default: false,
      last_seen_at: STALE, // …but the bot is gone
    },
    {
      id: "acc-disc",
      name: "Off",
      phone: null,
      status: "disconnected",
      enabled: true,
      is_default: false,
      last_seen_at: null,
    },
  ];
  db.whatsapp_bot_settings = [{ id: "bot-1", paused: false, last_bot_seen_at: STALE }];
  db.whatsapp_commands = [];
  insertedCommands = [];
}

mock.module("@/lib/store", () => ({
  IS_DEMO_MODE: false,
  store: {
    get: async (table: string, id: string) => (db[table] ?? []).find((r) => r.id === id) ?? null,
    first: async (table: string, filters: Record<string, unknown>) =>
      (db[table] ?? []).find((r) => Object.entries(filters).every(([k, v]) => r[k] === v)) ?? null,
    list: async (table: string) => ({ rows: db[table] ?? [], total: (db[table] ?? []).length }),
    insert: async (table: string, payload: Record<string, unknown>) => {
      insertedCommands.push({ table, payload });
      return { id: "cmd-new", ...payload };
    },
    count: async (table: string, filters?: Record<string, unknown>) => {
      let rows = db[table] ?? [];
      for (const [k, v] of Object.entries(filters ?? {})) rows = rows.filter((r) => r[k] === v);
      return rows.length;
    },
    update: async (table: string, id: string, data: Record<string, unknown>) => {
      const row = (db[table] ?? []).find((r) => r.id === id);
      if (row) Object.assign(row, data);
      return { id, ...data };
    },
  },
}));

const { GET: accountsGET } = await import("../src/app/api/whatsapp/accounts/route");
const { POST: testPOST } = await import("../src/app/api/whatsapp/test/route");
const { GET: overviewGET } = await import("../src/app/api/whatsapp/overview/route");
const { isBotOnline, isAccountSessionLive } = await import("../src/lib/services/whatsapp");

const postReq = (body: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify(body) });
const getReq = () => new Request("http://x");

beforeEach(() => {
  resetDb();
  mockSession = { role: "super_admin", userId: "u-super", name: "Super" };
});

// ---- pure helpers ----------------------------------------------------------
describe("isBotOnline / isAccountSessionLive", () => {
  it("bot heartbeat older than 90s means offline", () => {
    expect(isBotOnline({ last_bot_seen_at: FRESH })).toBe(true);
    expect(isBotOnline({ last_bot_seen_at: STALE })).toBe(false);
    expect(isBotOnline({ last_bot_seen_at: null })).toBe(false);
    expect(isBotOnline(null)).toBe(false);
  });

  it("session_live requires DB connected AND fresh per-account heartbeat", () => {
    expect(isAccountSessionLive({ status: "connected", last_seen_at: FRESH })).toBe(true);
    // DB says connected but bot died — NOT live
    expect(isAccountSessionLive({ status: "connected", last_seen_at: STALE })).toBe(false);
    expect(isAccountSessionLive({ status: "connected", last_seen_at: null })).toBe(false);
    expect(isAccountSessionLive({ status: "connecting", last_seen_at: FRESH })).toBe(false);
    expect(isAccountSessionLive({ status: "disconnected", last_seen_at: FRESH })).toBe(false);
    expect(isAccountSessionLive(null)).toBe(false);
  });
});

// ---- GET /api/whatsapp/accounts --------------------------------------------
describe("GET /api/whatsapp/accounts — session_live evidence", () => {
  it("marks only genuinely live sessions", async () => {
    const res = await accountsGET(getReq());
    const body = await res.json();
    const byId = new Map<string, { id: string; session_live: boolean }>(body.rows.map((r: never) => [(r as { id: string }).id, r]));
    expect(byId.get("acc-live")!.session_live).toBe(true);
    expect(byId.get("acc-stale")!.session_live).toBe(false);
    expect(byId.get("acc-disc")!.session_live).toBe(false);
  });
});

// ---- POST /api/whatsapp/test ----------------------------------------------
describe("POST /api/whatsapp/test — bot offline handling", () => {
  it("refuses with an explicit offline error when the bot heartbeat is stale", async () => {
    const res = await testPOST(postReq({ kind: "message", account_id: "acc-live", phone: "03001234567", message: "hi" }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/Bot is offline/i);
    expect(insertedCommands).toHaveLength(0); // nothing queued behind the dead bot
  });

  it("refuses a stale 'connected' account even while the bot is online", async () => {
    db.whatsapp_bot_settings = [{ id: "bot-1", paused: false, last_bot_seen_at: FRESH }];
    const res = await testPOST(postReq({ kind: "message", account_id: "acc-stale", phone: "03001234567", message: "hi" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/not reported its session recently/i);
    expect(insertedCommands).toHaveLength(0);
  });

  it("queues the test command when the bot and the session are live", async () => {
    db.whatsapp_bot_settings = [{ id: "bot-1", paused: false, last_bot_seen_at: FRESH }];
    const res = await testPOST(postReq({ kind: "message", account_id: "acc-live", phone: "03001234567", message: "hi" }));
    expect(res.status).toBe(200);
    expect(insertedCommands).toHaveLength(1);
    expect(insertedCommands[0].payload.command).toBe("test_message");
    // recipient stored normalized inside the command payload
    const cmdPayload = insertedCommands[0].payload.payload as Record<string, unknown>;
    expect(cmdPayload.phone).toBe("923001234567");
  });

  it("rejects an invalid number without queueing anything", async () => {
    db.whatsapp_bot_settings = [{ id: "bot-1", paused: false, last_bot_seen_at: FRESH }];
    const res = await testPOST(postReq({ kind: "message", account_id: "acc-live", phone: "0301234567", message: "hi" }));
    expect(res.status).toBe(422);
    expect(insertedCommands).toHaveLength(0);
  });
});

// ---- GET /api/whatsapp/overview -------------------------------------------
describe("GET /api/whatsapp/overview — live vs stale counting", () => {
  it("counts live sessions separately from stale rows and reports bot_online=false", async () => {
    const res = await overviewGET(getReq());
    const body = await res.json();
    expect(body.accounts.connected).toBe(1); // acc-live only
    expect(body.accounts.stale_connected).toBe(1); // acc-stale
    expect(body.bot_online).toBe(false); // heartbeat stale
  });

  it("reports bot online when the heartbeat is fresh", async () => {
    db.whatsapp_bot_settings = [{ id: "bot-1", paused: false, last_bot_seen_at: FRESH }];
    const res = await overviewGET(getReq());
    const body = await res.json();
    expect(body.bot_online).toBe(true);
  });
});
