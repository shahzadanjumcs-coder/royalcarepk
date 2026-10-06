/// <reference types="bun-types" />
/**
 * Final production-audit regression tests.
 *
 * Covers the server-side fixes from the FINAL PRODUCTION AUDIT:
 *   1. POST /api/orders/[id]/sync restricted to admin roles (was withAuth("any")
 *      → any worker could trigger commission/inventory cascades for ANY order)
 *   2. Worker order submissions: cod_amount pinned to the server-computed
 *      catalogue total (commission base can no longer be inflated by the client)
 *   3. approveOrder refuses CANCELLED orders (impossible state transition)
 *   4. GET /api/flaship/catalog + GET /api/customers restricted to staff
 *      (Flaship config / full customer rows are no longer exposed to workers)
 *   5. pickFields PATCH whitelisting (unknown keys can no longer reach store.update)
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import {
  buildFlashipServiceMock,
  flashipServiceCalls,
  resetFlashipServiceMock,
} from "./helpers/flaship_service_mock";

// ---------------- shared mocks ----------------

type SessionShape = { role: string; user_id: string } | null;
let mockSession: SessionShape = { role: "super_admin", user_id: "u-admin" };
mock.module("@/lib/auth/session", () => ({ getSession: async () => mockSession }));

mock.module("@/lib/services/audit", () => ({
  logAudit: async () => undefined,
  notifyAdmins: async () => undefined,
}));
mock.module("@/lib/services/notifications", () => ({
  notifyAdmins: async () => undefined,
  notifyWorker: async () => undefined,
}));
mock.module("@/lib/services/whatsapp", () => ({ enqueueWhatsAppOrderEvent: async () => undefined }));
mock.module("@/lib/services/inventory", () => ({
  reserveForOrder: async () => undefined,
  finalizeForOrder: async () => undefined,
  restoreForOrder: async () => undefined,
  releaseForOrder: async () => undefined,
}));
mock.module("@/lib/services/commission", () => ({ processCommissionForStatus: async () => undefined }));

// Shared service mock (complete surface + shared recorder) — identical in
// every file that mocks "@/lib/flaship/service", so cross-file registration
// order can never break named imports (see helpers/flaship_service_mock.ts).
mock.module("@/lib/flaship/service", () => buildFlashipServiceMock());

const tableRows: Record<string, Record<string, unknown>[]> = {
  orders: [],
  customers: [{ id: "c1", name: "Ali", phone: "03001234567", city: "Lahore", address: "x", status: "active", email: "a@b.c", notes: "private" }],
  products: [],
};
const insertCalls: { table: string; payload: Record<string, unknown> }[] = [];
const getStore = new Map<string, Record<string, unknown>>();

mock.module("@/lib/store", () => ({
  IS_DEMO_MODE: false,
  store: {
    list: async (table: string) => ({ rows: tableRows[table] ?? [], total: (tableRows[table] ?? []).length }),
    get: async (table: string, id: string) => getStore.get(`${table}:${id}`) ?? null,
    first: async (table: string, filters: Record<string, unknown>) =>
      (tableRows[table] ?? []).find((r) => Object.entries(filters).every(([k, v]) => r[k] === v)) ?? null,
    insert: async (table: string, payload: Record<string, unknown>) => {
      insertCalls.push({ table, payload });
      return { id: `new-${insertCalls.length}`, ...payload };
    },
    count: async () => 0,
  },
}));

const jsonRes = async (res: Response) => ({ status: res.status, body: await res.json() });

beforeEach(() => {
  mockSession = { role: "super_admin", user_id: "u-admin" };
  resetFlashipServiceMock();
  insertCalls.length = 0;
  getStore.clear();
});

// ---------------- route imports (after mocks) ----------------

const { POST: syncPOST } = await import("../src/app/api/orders/[id]/sync/route");
const { GET: catalogGET } = await import("../src/app/api/flaship/catalog/route");
const { GET: customersGET } = await import("../src/app/api/customers/route");
const { pickFields } = await import("../src/lib/api/helpers");
// The "?real" query gives this file a fresh, unmocked evaluation of the orders
// service — same isolation convention as flaship_booking_orders.test.ts. Other
// suite files mock "@/lib/services/orders" globally with partial fakes (e.g.
// only changeOrderStatus); bun shares one module registry across files, so a
// plain import can receive a fake depending on file execution order.
const REAL_ORDERS_SERVICE = "../src/lib/services/orders?real";
const ordersService = await import(REAL_ORDERS_SERVICE);

const ctxWith = (id: string) => ({ params: Promise.resolve({ id }) });

// ---------------------------------------------------------------
// 1. /api/orders/[id]/sync — admin-only (worker commission-cascade hole)
// ---------------------------------------------------------------
describe("POST /api/orders/[id]/sync role restriction", () => {
  it("allows super_admin to sync", async () => {
    const { status } = await jsonRes(await syncPOST(new Request("http://x", { method: "POST" }), ctxWith("o1")));
    expect(status).toBe(200);
    expect(flashipServiceCalls.filter((c) => c.fn === "syncOrderTracking")).toHaveLength(1);
  });

  it("forbids workers (403) — no cross-order commission/inventory cascades", async () => {
    mockSession = { role: "worker", user_id: "w1" };
    const { status } = await jsonRes(await syncPOST(new Request("http://x", { method: "POST" }), ctxWith("o1")));
    expect(status).toBe(403);
    expect(flashipServiceCalls.filter((c) => c.fn === "syncOrderTracking")).toHaveLength(0);
  });

  it("forbids anonymous callers (401)", async () => {
    mockSession = null;
    const { status } = await jsonRes(await syncPOST(new Request("http://x", { method: "POST" }), ctxWith("o1")));
    expect(status).toBe(401);
  });
});

// ---------------------------------------------------------------
// 2. createOrder — worker cod_amount pinned to server-computed total
// ---------------------------------------------------------------
describe("createOrder commission-base hardening", () => {
  const workerProfile = {
    id: "w1", role: "worker", status: "active", commission_rate: 10, name: "W", email: "w@x.c", worker_code: "W-0001",
  };

  it("pins cod_amount to the catalogue total for worker submissions (client value ignored)", async () => {
    getStore.set("profiles:w1", workerProfile);
    getStore.set("products:p1", { id: "p1", name: "Widget", sku: "W-1", selling_price: 100, status: "active" });
    const order = await ordersService.createOrder(
      { role: "worker", userId: "w1" },
      {
        customer: { name: "Ali", phone: "03001234567" },
        items: [{ product_id: "p1", quantity: 2, unit_price: 1 }], // client price ignored for workers
        discount: 0,
        cod_amount: 99999, // hostile client payload — must NOT become the commission base
        delivery_address: "12-B Gulberg",
        city: "Lahore",
      }
    );
    expect(order.cod_amount).toBe(200); // 2 × 100 catalogue price
    const orderInsert = insertCalls.find((c) => c.table === "orders")!;
    expect(orderInsert.payload.cod_amount).toBe(200);
    // worker unit prices are also catalogue-forced
    const itemInsert = insertCalls.find((c) => c.table === "order_items")!;
    expect(itemInsert.payload.unit_price).toBe(100);
    expect(itemInsert.payload.line_total).toBe(200);
  });

  it("still honours an admin's explicit cod_amount (existing admin behavior preserved)", async () => {
    getStore.set("products:p1", { id: "p1", name: "Widget", sku: "W-1", selling_price: 100, status: "active" });
    const order = await ordersService.createOrder(
      { role: "admin", userId: "a1" },
      {
        customer: { name: "Ali", phone: "03001234567" },
        items: [{ product_id: "p1", quantity: 1, unit_price: 100 }],
        discount: 0,
        cod_amount: 500,
        delivery_address: "12-B Gulberg",
        city: "Lahore",
      }
    );
    expect(order.cod_amount).toBe(500);
  });
});

// ---------------------------------------------------------------
// 3. approveOrder — impossible state transitions blocked
// ---------------------------------------------------------------
describe("approveOrder lifecycle guard", () => {
  it("refuses to approve a CANCELLED order", async () => {
    getStore.set("orders:o9", { id: "o9", status: "CANCELLED", approval_status: "PENDING", order_number: "ORD-X" });
    await expect(ordersService.approveOrder({ role: "admin", userId: "a1" }, "o9")).rejects.toThrow(/cancelled/i);
  });

  it("stays idempotent for already-APPROVED orders", async () => {
    getStore.set("orders:o2", { id: "o2", status: "PENDING", approval_status: "APPROVED", order_number: "ORD-Y" });
    const order = await ordersService.approveOrder({ role: "admin", userId: "a1" }, "o2");
    expect(order.id).toBe("o2");
  });
});

// ---------------------------------------------------------------
// 4. Staff-only reads: flaship catalog + full customer rows
// ---------------------------------------------------------------
describe("worker data-exposure restrictions", () => {
  it("GET /api/flaship/catalog forbids workers (Flaship config is staff-only)", async () => {
    mockSession = { role: "worker", user_id: "w1" };
    const { status } = await jsonRes(await catalogGET(new Request("http://x/api/flaship/catalog")));
    expect(status).toBe(403);
  });

  it("GET /api/customers forbids workers (full rows incl. email/notes are staff-only)", async () => {
    mockSession = { role: "worker", user_id: "w1" };
    const { status } = await jsonRes(await customersGET(new Request("http://x/api/customers")));
    expect(status).toBe(403);
  });

  it("GET /api/customers still works for admin", async () => {
    const { status, body } = await jsonRes(await customersGET(new Request("http://x/api/customers")));
    expect(status).toBe(200);
    expect(body.rows[0].phone).toBe("03001234567");
  });
});

// ---------------------------------------------------------------
// 5. pickFields — PATCH body whitelisting
// ---------------------------------------------------------------
describe("pickFields whitelist", () => {
  it("keeps only allowed columns", () => {
    const out = pickFields({ name: "T", rate: 5, hacked: "x", id: "y", created_at: "z" }, ["name", "rate"]);
    expect(out).toEqual({ name: "T", rate: 5 });
  });

  it("returns an empty object when nothing matches", () => {
    expect(pickFields({ foo: 1 } as Record<string, unknown>, ["name"])).toEqual({});
  });
});
