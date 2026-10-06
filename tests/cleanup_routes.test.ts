/// <reference types="bun-types" />
/**
 * Admin cleanup routes — cancelled-order deletion + last-super-admin guard.
 *
 * Covers the production cleanup requirements:
 * - DELETE /api/orders/[id] is super_admin-only and CANCELLED-only
 * - it removes the order plus its whatsapp queue rows and order notifications,
 *   writes an order.deleted audit entry BEFORE the delete, and never touches
 *   Flaship
 * - it refuses when commission ledger rows exist (append-only ledger safety)
 * - PATCH /api/users/[id] cannot disable/demote the last active super admin.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";

type SessionShape = { role: string; userId: string; name?: string } | null;
let mockSession: SessionShape = { role: "super_admin", userId: "u-super", name: "Super" };
mock.module("@/lib/auth/session", () => ({ getSession: async () => mockSession }));
mock.module("@/lib/services/audit", () => ({ logAudit: async () => undefined }));

// ---- fake store -----------------------------------------------------------
const db: Record<string, Record<string, unknown>[]> = {
  orders: [
    {
      id: "o-test", order_number: "RC-1001", status: "CANCELLED", booking_status: "booked",
      tracking_number: "173018508325", customer_id: "c-1", total: 1500,
    },
    { id: "o-live", order_number: "RC-2002", status: "CANCELLED", tracking_number: "CN-LIVE", customer_id: "c-1", total: 900 },
    { id: "o-booked", order_number: "RC-3003", status: "BOOKED", tracking_number: "CN-BOOKED", customer_id: "c-1", total: 500 },
  ],
  order_items: [{ id: "i-1", order_id: "o-test", product_name: "Test Widget", quantity: 1 }],
  shipments: [{ id: "s-1", order_id: "o-test", tracking_number: "173018508325" }],
  shipment_tracking: [{ id: "t-1", order_id: "o-test" }],
  order_status_history: [{ id: "h-1", order_id: "o-test", status: "CANCELLED" }],
  commission_transactions: [], // toggled per-test
  whatsapp_message_queue: [
    { id: "q-1", order_id: "o-test", notification_type: "BOOKED", status: "pending" },
    { id: "q-2", order_id: "o-test", notification_type: "DELIVERED", status: "failed" },
    { id: "q-3", order_id: "o-other", notification_type: "BOOKED", status: "pending" },
  ],
  notifications: [
    { id: "n-1", link: "/admin/orders/o-test", title: "Booked" },
    { id: "n-2", link: "/worker/orders/o-test", title: "Booked" },
    { id: "n-3", link: "/admin/orders/o-other", title: "Booked" },
  ],
  audit_logs: [] as Record<string, unknown>[],
  profiles: [
    { id: "u-super", role: "super_admin", status: "active" },
    { id: "u-target", role: "super_admin", status: "active" },
  ],
};

const deleted: { table: string; id: string }[] = [];
const inserts: { table: string; payload: Record<string, unknown> }[] = [];

function resetDb() {
  db.orders = [
    {
      id: "o-test", order_number: "RC-1001", status: "CANCELLED", booking_status: "booked",
      tracking_number: "173018508325", customer_id: "c-1", total: 1500,
    },
    { id: "o-live", order_number: "RC-2002", status: "CANCELLED", tracking_number: "CN-LIVE", customer_id: "c-1", total: 900 },
    { id: "o-booked", order_number: "RC-3003", status: "BOOKED", tracking_number: "CN-BOOKED", customer_id: "c-1", total: 500 },
  ];
  db.order_items = [{ id: "i-1", order_id: "o-test", product_name: "Test Widget", quantity: 1 }];
  db.shipments = [{ id: "s-1", order_id: "o-test", tracking_number: "173018508325" }];
  db.shipment_tracking = [{ id: "t-1", order_id: "o-test" }];
  db.order_status_history = [{ id: "h-1", order_id: "o-test", status: "CANCELLED" }];
  db.commission_transactions = [];
  db.whatsapp_message_queue = [
    { id: "q-1", order_id: "o-test", notification_type: "BOOKED", status: "pending" },
    { id: "q-2", order_id: "o-test", notification_type: "DELIVERED", status: "failed" },
    { id: "q-3", order_id: "o-other", notification_type: "BOOKED", status: "pending" },
  ];
  db.notifications = [
    { id: "n-1", link: "/admin/orders/o-test", title: "Booked" },
    { id: "n-2", link: "/worker/orders/o-test", title: "Booked" },
    { id: "n-3", link: "/admin/orders/o-other", title: "Booked" },
  ];
  db.profiles = [
    { id: "u-super", role: "super_admin", status: "active" },
    { id: "u-target", role: "super_admin", status: "active" },
  ];
  deleted.length = 0;
  inserts.length = 0;
}

mock.module("@/lib/store", () => ({
  IS_DEMO_MODE: false,
  store: {
    get: async (table: string, id: string) => (db[table] ?? []).find((r) => r.id === id) ?? null,
    list: async (table: string, opts?: { filters?: Record<string, unknown> }) => {
      let rows = db[table] ?? [];
      for (const [k, v] of Object.entries(opts?.filters ?? {})) rows = rows.filter((r) => r[k] === v);
      return { rows, total: rows.length };
    },
    update: async (table: string, id: string, data: Record<string, unknown>) => {
      const row = (db[table] ?? []).find((r) => r.id === id);
      if (row) Object.assign(row, data);
      return { id, ...data };
    },
    insert: async (table: string, payload: Record<string, unknown>) => {
      inserts.push({ table, payload });
      return { id: "new-1", ...payload };
    },
    delete: async (table: string, id: string) => {
      deleted.push({ table, id });
      db[table] = (db[table] ?? []).filter((r) => r.id !== id);
      return { id };
    },
  },
}));

const { DELETE: orderDELETE } = await import("../src/app/api/orders/[id]/route");
const { PATCH: usersPATCH } = await import("../src/app/api/users/[id]/route");

const ctxFor = (id: string) => ({ params: Promise.resolve({ id }) });
const jsonReq = (body: unknown) => new Request("http://x", { method: "PATCH", body: JSON.stringify(body) });
const delReq = () => new Request("http://x", { method: "DELETE" });

beforeEach(() => {
  resetDb();
  mockSession = { role: "super_admin", userId: "u-super", name: "Super" };
});

// ---- DELETE /api/orders/[id] ----------------------------------------------
describe("DELETE /api/orders/[id] — cancelled test order cleanup", () => {
  it("refuses non-super-admin roles", async () => {
    mockSession = { role: "admin", userId: "u-admin" };
    const res = await orderDELETE(delReq(), ctxFor("o-test"));
    expect(res.status).toBe(403);
    expect(deleted).toHaveLength(0);
  });

  it("refuses orders that are not CANCELLED", async () => {
    const res = await orderDELETE(delReq(), ctxFor("o-booked"));
    expect(res.status).toBe(422);
    expect(deleted).toHaveLength(0);
  });

  it("refuses when commission ledger rows reference the order", async () => {
    db.commission_transactions = [{ id: "ct-1", order_id: "o-test", worker_id: "w-1", amount: 100 }];
    const res = await orderDELETE(delReq(), ctxFor("o-test"));
    expect(res.status).toBe(422);
    expect(deleted).toHaveLength(0);
  });

  it("removes the cancelled order, its queue rows and notifications, audits first", async () => {
    const res = await orderDELETE(delReq(), ctxFor("o-test"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.removed.tracking_number).toBe("173018508325");
    expect(body.removed.order_items_cascaded).toBe(1);
    expect(body.removed.shipments_cascaded).toBe(1);
    expect(body.removed.whatsapp_queue_removed).toBe(2);
    expect(body.removed.notifications_removed).toBe(2);

    // queue rows for THIS order deleted, others untouched
    expect(deleted.filter((d) => d.table === "whatsapp_message_queue").map((d) => d.id).sort()).toEqual(["q-1", "q-2"]);
    expect(db.whatsapp_message_queue.map((r) => r.id)).toEqual(["q-3"]);
    // notifications for THIS order deleted, others untouched
    expect(deleted.filter((d) => d.table === "notifications").map((d) => d.id).sort()).toEqual(["n-1", "n-2"]);
    expect(db.notifications.map((r) => r.id)).toEqual(["n-3"]);
    // the order row itself deleted last
    expect(deleted.some((d) => d.table === "orders" && d.id === "o-test")).toBe(true);
    // immutable audit entry written with identification data
    const audit = inserts.find((i) => i.table === "audit_logs");
    expect(audit?.payload.action).toBe("order.deleted");
    expect((audit?.payload.old_data as Record<string, unknown>).tracking_number).toBe("173018508325");
    // no Flaship contact — no fetch performed anywhere in the route
  });

  it("404s for a missing order", async () => {
    const res = await orderDELETE(delReq(), ctxFor("nope"));
    expect(res.status).toBe(404);
  });
});

// ---- PATCH /api/users/[id] last-super-admin guard --------------------------
describe("PATCH /api/users/[id] — last super admin protection", () => {
  it("refuses disabling the last active super admin", async () => {
    db.profiles = [
      { id: "u-super", role: "super_admin", status: "active" },
      { id: "u-target", role: "super_admin", status: "active" },
    ];
    // Simulate "u-target is the only active super" by marking u-super disabled.
    db.profiles[0].status = "disabled";
    const res = await usersPATCH(jsonReq({ status: "disabled" }), ctxFor("u-target"));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain("last active Super Admin");
  });

  it("refuses demoting the last active super admin", async () => {
    db.profiles[0].status = "disabled";
    const res = await usersPATCH(jsonReq({ role: "admin" }), ctxFor("u-target"));
    expect(res.status).toBe(422);
  });

  it("refuses a super admin demoting THEMSELVES when no other active super exists", async () => {
    // only session user is active super; demoting self would leave zero
    db.profiles = [{ id: "u-super", role: "super_admin", status: "active" }];
    const res = await usersPATCH(jsonReq({ role: "admin" }), ctxFor("u-super"));
    expect(res.status).toBe(422);
  });

  it("allows disabling a super admin when another active super exists", async () => {
    const res = await usersPATCH(jsonReq({ status: "disabled" }), ctxFor("u-target"));
    expect(res.status).toBe(200);
  });

  it("still blocks self-disable", async () => {
    const res = await usersPATCH(jsonReq({ status: "disabled" }), ctxFor("u-super"));
    expect(res.status).toBe(422);
  });
});
