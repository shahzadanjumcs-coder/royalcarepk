/// <reference types="bun-types" />
/**
 * Flaship route-level tests — /api/flaship/test + /api/lookup.
 *
 * Route handlers are exercised for real (withAuth auth/role enforcement +
 * JSON responses); the DB layer (store) and the Flaship service are mocked so
 * no database, network or secrets are involved.
 *
 * Coverage (bug-fix regression, production d3aab49):
 *   1. POST /api/flaship/test  → was 404 (route missing), now 200 + service result
 *   2. GET  /api/lookup        → was 500 (flaship_pickup_couriers.created_at crash),
 *                                now 200 exposing pickup_couriers mapping
 *   3. worker scoping          → lookup must NOT expose Flaship config to workers
 *   4. courier lookup          → mapping composed with filterPickupsForCourier
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { filterPickupsForCourier } from "../src/lib/flaship/protocol";

// ---------------- mocks (registered BEFORE route imports) ----------------

type SessionShape = { role: string; user_id: string } | null;
let mockSession: SessionShape = { role: "super_admin", user_id: "u-admin" };

mock.module("@/lib/auth/session", () => ({
  getSession: async () => mockSession,
}));

const serviceCalls: { fn: string; args: unknown[] }[] = [];
mock.module("@/lib/flaship/service", () => ({
  testFlashipConnection: async (...args: unknown[]) => {
    serviceCalls.push({ fn: "testFlashipConnection", args });
    return testConnectionResult;
  },
  getFlashipConfig: async () => ({
    mode: "live",
    api_key_set: true,
    default_courier: "Leopard",
    default_pickup: "PK-9012",
  }),
}));

let testConnectionResult: { ok: boolean; message: string; mode: string } = {
  ok: true,
  message: "Connected. Catalog loaded: 3 courier(s).",
  mode: "live",
};

// Fake store: table → rows, records every list() call for assertions.
const tableRows: Record<string, Record<string, unknown>[]> = {
  customers: [{ id: "c1", name: "Ali", phone: "03001234567", city: "Lahore", address: "x", status: "active" }],
  products: [{ id: "p1", name: "Widget", sku: "W-1", selling_price: 100, current_stock: 5, reserved_stock: 1, status: "active" }],
  profiles: [{ id: "w1", name: "Worker One", commission_rate: 0.1, status: "active", role: "worker" }],
  flaship_couriers: [
    { id: "k1", courier_id: "Leopard", name: "Leopard", active: true },
    { id: "k2", courier_id: "TCS", name: "TCS", active: true },
  ],
  flaship_cities: [{ id: "ct1", city_id: "lahore", name: "Lahore", active: true }],
  flaship_pickups: [
    { id: "pk1", pickup_id: "PK-9012", name: "Hub A", city: "Lahore", active: true },
    { id: "pk2", pickup_id: "PK-7777", name: "Hub B", city: "Karachi", active: true },
  ],
  flaship_pickup_couriers: [
    { id: "m1", pickup_id: "PK-9012", courier_id: "Leopard", synced_at: "2026-10-06T00:00:00Z" },
    { id: "m2", pickup_id: "PK-7777", courier_id: "TCS", synced_at: "2026-10-06T00:00:00Z" },
  ],
};
const listCalls: { table: string; orderBy: unknown }[] = [];

mock.module("@/lib/store", () => ({
  IS_DEMO_MODE: false,
  store: {
    list: async (table: string, opts?: { orderBy?: unknown }) => {
      listCalls.push({ table, orderBy: opts?.orderBy });
      return { rows: tableRows[table] ?? [], total: (tableRows[table] ?? []).length };
    },
  },
}));

// ---------------- route imports (after mocks) ----------------

const { POST: testRoutePOST } = await import("../src/app/api/flaship/test/route");
const { GET: lookupGET } = await import("../src/app/api/lookup/route");

const jsonRes = async (res: Response) => ({ status: res.status, body: await res.json() });
const getReq = () => new Request("http://localhost/api/lookup");

beforeEach(() => {
  mockSession = { role: "super_admin", user_id: "u-admin" };
  serviceCalls.length = 0;
  listCalls.length = 0;
  testConnectionResult = { ok: true, message: "Connected. Catalog loaded: 3 courier(s).", mode: "live" };
});

// ---------------------------------------------------------------
// 1. POST /api/flaship/test — previously 404 (route did not exist)
// ---------------------------------------------------------------
describe("POST /api/flaship/test", () => {
  it("returns 200 with the service connectivity result (admin)", async () => {
    const { status, body } = await jsonRes(await testRoutePOST(new Request("http://localhost/api/flaship/test", { method: "POST" })));
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.message).toContain("Connected");
    expect(body.mode).toBe("live");
    expect(serviceCalls).toHaveLength(1);
  });

  it("surfaces a real Flaship failure message with ok:false (no generic masking)", async () => {
    testConnectionResult = { ok: false, message: "Flaship API error (HTTP 400)", mode: "live" };
    const { status, body } = await jsonRes(await testRoutePOST(new Request("http://localhost/api/flaship/test", { method: "POST" })));
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.message).toBe("Flaship API error (HTTP 400)");
  });

  it("forbids workers (403) and anonymous callers (401)", async () => {
    mockSession = { role: "worker", user_id: "u-w" };
    expect((await jsonRes(await testRoutePOST(new Request("http://localhost/api/flaship/test", { method: "POST" })))).status).toBe(403);
    mockSession = null;
    expect((await jsonRes(await testRoutePOST(new Request("http://localhost/api/flaship/test", { method: "POST" })))).status).toBe(401);
  });
});

// ---------------------------------------------------------------
// 2. GET /api/lookup — previously 500 (mapping table default order)
// ---------------------------------------------------------------
describe("GET /api/lookup", () => {
  it("returns 200 with couriers, cities, pickups, pickup_couriers and flaship config", async () => {
    const { status, body } = await jsonRes(await lookupGET(getReq()));
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    expect(body.couriers.map((c: { courier_id: string }) => c.courier_id)).toEqual(["Leopard", "TCS"]);
    expect(body.pickups).toHaveLength(2);
    expect(body.cities.map((c: { name: string }) => c.name)).toEqual(["Lahore"]);
    // the pickup↔courier mapping must be exposed for the booking UI filter
    expect(body.pickup_couriers).toHaveLength(2);
    expect(body.flaship).toEqual({ mode: "live", default_courier: "Leopard", default_pickup: "PK-9012" });
    // every catalog table was queried through the store
    const tables = listCalls.map((c) => c.table);
    for (const t of ["customers", "products", "profiles", "flaship_couriers", "flaship_cities", "flaship_pickups", "flaship_pickup_couriers"]) {
      expect(tables).toContain(t);
    }
  });

  it("scopes workers to customers+products only (no Flaship data exposure)", async () => {
    mockSession = { role: "worker", user_id: "u-w" };
    const { status, body } = await jsonRes(await lookupGET(getReq()));
    expect(status).toBe(200);
    expect(body.customers).toHaveLength(1);
    expect(body.products[0].available_stock).toBe(4); // current_stock - reserved_stock
    expect(body.couriers).toBeUndefined();
    expect(body.pickups).toBeUndefined();
    expect(body.pickup_couriers).toBeUndefined();
    expect(body.flaship).toBeUndefined();
  });
});

// ---------------------------------------------------------------
// 3. Courier lookup + mapped pickup filtering (lookup payload → UI filter)
// ---------------------------------------------------------------
describe("courier lookup + mapped pickup filtering", () => {
  it("shows only pickups mapped to the selected courier", () => {
    const pickups = tableRows.flaship_pickups.map((p) => ({ ...p }));
    const links = tableRows.flaship_pickup_couriers.map((l) => ({
      pickup_id: l.pickup_id as string,
      courier_id: l.courier_id as string,
    }));
    const leopard = filterPickupsForCourier(pickups as { pickup_id: string }[], links, "Leopard");
    expect(leopard.map((p) => p.pickup_id)).toEqual(["PK-9012"]);
    const tcs = filterPickupsForCourier(pickups as { pickup_id: string }[], links, "TCS");
    expect(tcs.map((p) => p.pickup_id)).toEqual(["PK-7777"]);
  });

  it("degrades gracefully when the mapping is empty (courier lookup still usable)", () => {
    const pickups = tableRows.flaship_pickups.map((p) => ({ ...p }));
    expect(filterPickupsForCourier(pickups as { pickup_id: string }[], [], "Leopard")).toHaveLength(2);
  });

  it("yields an empty list for a courier the mapping knows has no pickups", () => {
    const pickups = tableRows.flaship_pickups.map((p) => ({ ...p }));
    const links = [{ pickup_id: "PK-9012", courier_id: "Leopard" }];
    expect(filterPickupsForCourier(pickups as { pickup_id: string }[], links, "PostEx")).toEqual([]);
  });
});
