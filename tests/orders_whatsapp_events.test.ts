/// <reference types="bun-types" />
/**
 * Booking-notification + order-transition regressions.
 *
 * Covers the production WhatsApp requirements:
 * - a successful booking on an admin-created (CREATED) order moves the order
 *   to BOOKED (was: threw "Cannot change status from CREATED to BOOKED" AFTER
 *   Flaship had already booked → no WhatsApp event, orphan shipment)
 * - BOOKED events enqueue a customer notification exactly once (unique
 *   dedupe_key pre-check + 23505 race protection)
 * - cancelled orders never enqueue a WhatsApp booking message
 * - failed bookings never enqueue (bookOrderWithFlaship catch path only
 *   notifies admins in-app — covered by flaship_booking_orders.test.ts)
 *
 * The orders service is imported via the suite's "?real" convention — bun
 * shares one module registry across files and other files mock
 * "@/lib/services/orders" with partial fakes. The REAL whatsapp fan-out runs
 * against the mocked store so exactly-once semantics are verified end-to-end.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";

mock.module("server-only", () => ({}));

// ---- spies for orders.ts collaborators ------------------------------------
const inventoryCalls = { release: 0, restore: 0, finalize: 0, reserve: 0 };
const commissionCalls: string[] = [];

mock.module("@/lib/services/inventory", () => ({
  reserveForOrder: async () => { inventoryCalls.reserve += 1; },
  finalizeForOrder: async () => { inventoryCalls.finalize += 1; },
  restoreForOrder: async () => { inventoryCalls.restore += 1; },
  releaseForOrder: async () => { inventoryCalls.release += 1; },
}));
mock.module("@/lib/services/commission", () => ({
  processCommissionForStatus: async (_orderId: string, status: string) => { commissionCalls.push(status); },
}));
mock.module("@/lib/services/notifications", () => ({
  notifyAdmins: async () => undefined,
  notifyWorker: async () => undefined,
}));
mock.module("@/lib/services/audit", () => ({ logAudit: async () => undefined }));

// ---- store fake (serves BOTH the orders service and the real whatsapp fan-out)
const db: Record<string, Record<string, unknown>[]> = {
  orders: [
    { id: "o-created", order_number: "RC-A", status: "CREATED", customer_id: "c-1", total: 100, tracking_number: "CN-TEST-1", flaship_courier_name: "Leopard" },
    { id: "o-pending", order_number: "RC-B", status: "PENDING", customer_id: "c-1", total: 200, worker_id: "w-1", tracking_number: null },
  ],
  order_status_history: [],
  customers: [{ id: "c-1", name: "Ali Raza", phone: "03001234567" }],
  shipment_tracking: [],
  whatsapp_routing_settings: [], // empty → enabled defaults + default templates
  whatsapp_bot_settings: [{ id: "ws-1", paused: false, max_retries: 3 }],
  whatsapp_message_queue: [],
  whatsapp_admin_recipients: [],
  whatsapp_group_settings: [],
};

const inserted: { table: string; payload: Record<string, unknown> }[] = [];

mock.module("@/lib/store", () => ({
  IS_DEMO_MODE: false,
  store: {
    get: async (table: string, id: string) => (db[table] ?? []).find((r) => r.id === id) ?? null,
    first: async (table: string, filters: Record<string, unknown> = {}) => {
      let rows = db[table] ?? [];
      for (const [k, v] of Object.entries(filters)) rows = rows.filter((r) => r[k] === v);
      return rows[0] ?? null;
    },
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
      inserted.push({ table, payload });
      if (!db[table]) db[table] = [];
      db[table].push({ id: `new-${inserted.length}`, ...payload });
      return { id: `new-${inserted.length}`, ...payload };
    },
    delete: async () => undefined,
  },
}));

const REAL_WHATSAPP_SERVICE = "../src/lib/services/whatsapp?real";
const { enqueueWhatsAppOrderEvent } = await import(REAL_WHATSAPP_SERVICE);

// Other suite files (flaship_booking_orders / production_audit) register a
// no-op "@/lib/services/whatsapp" mock, and bun shares one module registry —
// so the REAL orders service above would silently swallow booking events.
// Re-register the specifier as a delegating wrapper: records calls AND runs
// the real fan-out against the mocked store. Files that re-register their own
// mock later (production_audit does) are unaffected for their own imports.
const enqueueCalls: { orderId: string; type: string }[] = [];
mock.module("@/lib/services/whatsapp", () => ({
  enqueueWhatsAppOrderEvent: async (params: { orderId: string; type: string }) => {
    enqueueCalls.push(params);
    return enqueueWhatsAppOrderEvent(params);
  },
}));
const REAL_ORDERS_SERVICE = "../src/lib/services/orders?real";
const { changeOrderStatus: changeOrderStatusReal } = await import(REAL_ORDERS_SERVICE);
const changeOrderStatusFn = changeOrderStatusReal;

const actor = { userId: "u-super", name: "Super", role: "super_admin" } as never;
const changeOrderStatus = changeOrderStatusFn;
const queueRows = () => db.whatsapp_message_queue as { dedupe_key: string; status: string; recipient: string }[];

beforeEach(() => {
  inventoryCalls.release = 0; inventoryCalls.restore = 0; inventoryCalls.finalize = 0; inventoryCalls.reserve = 0;
  commissionCalls.length = 0;
  enqueueCalls.length = 0;
  inserted.length = 0;
  db.order_status_history = [];
  db.whatsapp_message_queue = [];
  (db.orders.find((o) => o.id === "o-created") as Record<string, unknown>).status = "CREATED";
  (db.orders.find((o) => o.id === "o-pending") as Record<string, unknown>).status = "PENDING";
  (db.customers[0] as Record<string, unknown>).phone = "03001234567";
});

describe("changeOrderStatus — booking transition fixes", () => {
  it("allows CREATED → BOOKED and fans out the customer notification", async () => {
    const order = await changeOrderStatus(actor, "o-created", "BOOKED", "Booked with Leopard");
    expect(order.status).toBe("BOOKED");
    expect(commissionCalls).toEqual(["BOOKED"]); // hook runs; credits nothing
    expect(inventoryCalls.release).toBe(0); // booking does not release stock
    // exactly one BOOKED whatsapp row for the customer (delegating wrapper →
    // real fan-out) and one recorded enqueue call
    expect(enqueueCalls).toEqual([{ orderId: "o-created", type: "BOOKED" }]);
    const rows = queueRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupe_key).toBe("o-created:BOOKED:923001234567");
    expect(rows[0].status).toBe("pending");
  });

  it("still allows CREATED → PENDING / CANCELLED — no whatsapp event", async () => {
    await changeOrderStatus(actor, "o-created", "PENDING");
    expect(queueRows()).toHaveLength(0); // PENDING → no whatsapp event
    (db.orders.find((o) => o.id === "o-created") as Record<string, unknown>).status = "CREATED";
    await changeOrderStatus(actor, "o-created", "CANCELLED");
    expect(inventoryCalls.release).toBe(1); // reservation released
    expect(queueRows()).toHaveLength(0); // CANCELLED → no booking message
  });

  it("PENDING → BOOKED enqueues the customer notification once", async () => {
    await changeOrderStatus(actor, "o-pending", "BOOKED");
    expect(queueRows()).toHaveLength(1);
    expect(queueRows()[0].dedupe_key).toBe("o-pending:BOOKED:923001234567");
  });
});

describe("enqueueWhatsAppOrderEvent — exactly-once fan-out (real implementation)", () => {
  it("enqueues exactly one pending customer row for BOOKED", async () => {
    await enqueueWhatsAppOrderEvent({ orderId: "o-created", type: "BOOKED" });
    const rows = inserted.filter((i) => i.table === "whatsapp_message_queue");
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.recipient).toBe("923001234567"); // 03… normalized
    expect(rows[0].payload.recipient_kind).toBe("customer");
    expect(rows[0].payload.status).toBe("pending");
    expect(String(rows[0].payload.dedupe_key)).toBe("o-created:BOOKED:923001234567");
    // template rendered with booking facts (CN, courier, order number)
    const msg = String(rows[0].payload.message);
    expect(msg).toContain("RC-A");
  });

  it("is idempotent — a repeated event inserts nothing (dedupe pre-check)", async () => {
    await enqueueWhatsAppOrderEvent({ orderId: "o-created", type: "BOOKED" });
    await enqueueWhatsAppOrderEvent({ orderId: "o-created", type: "BOOKED" });
    const rows = inserted.filter((i) => i.table === "whatsapp_message_queue");
    expect(rows).toHaveLength(1); // second call short-circuits on dedupe_key
  });

  it("treats a concurrent unique-violation as success (race-safe)", async () => {
    // force the pre-check to miss, then make insert collide like prod would
    const storeMod = (await import("../src/lib/store")) as unknown as {
      store: { first: (t: string, f?: Record<string, unknown>) => Promise<unknown>; insert: (t: string, p: Record<string, unknown>) => Promise<unknown> };
    };
    const realFirst = storeMod.store.first;
    const realInsert = storeMod.store.insert;
    storeMod.store.first = async () => null;
    storeMod.store.insert = async () => {
      throw new Error('duplicate key value violates unique constraint "whatsapp_message_queue_dedupe_key_key"');
    };
    await expect(enqueueWhatsAppOrderEvent({ orderId: "o-created", type: "BOOKED" })).resolves.toBeUndefined();
    storeMod.store.first = realFirst;
    storeMod.store.insert = realInsert;
  });

  it("records invalid customer numbers once as failed rows (no retry loop)", async () => {
    (db.customers[0] as Record<string, unknown>).phone = "12345"; // invalid PK number
    await enqueueWhatsAppOrderEvent({ orderId: "o-created", type: "BOOKED" });
    const rows = inserted.filter((i) => i.table === "whatsapp_message_queue");
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.status).toBe("failed");
    expect(String(rows[0].payload.failure_reason)).toContain("valid");
  });
});
