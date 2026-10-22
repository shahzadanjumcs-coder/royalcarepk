/// <reference types="bun-types" />
/**
 * Tracking-sync regressions — Leopard free-text statuses (2026-10 bug).
 *
 * Production symptom: order OK7546914590 (Leopard via Flaship) had the
 * courier scan "ASSIGNED TO COURIER IN SARGODHA, 22 Oct 15:02", but Sync
 * Tracking reported "Tracking is up to date." forever, the order status
 * never left BOOKED, and no customer WhatsApp was enqueued.
 *
 * Root cause: STATUS_MAP was consulted by EXACT key match on the raw courier
 * status string. Leopards emits free-text checkpoints ("ASSIGNED TO COURIER
 * IN SARGODHA", "SHIPMENT PICKED IN LAHORE", …) that are not exact keys, so
 * `mapped` stayed undefined → no status change; once the checkpoints were
 * persisted (status+date dedupe) every later sync hit added=0 → the literal
 * "Tracking is up to date." message. The WhatsApp triggers compared exact raw
 * strings too, so free-text "OUT FOR DELIVERY" (with spaces) never matched.
 *
 * Fix under test:
 * - normalizeCourierStatus() maps the verified Leopards vocabulary to
 *   canonical keys ("Assigned to courier in {city}" → In-transit step, NEVER
 *   out-for-delivery — Leopards scans OFD separately; "Delivered to
 *   Warehouse/Vendor" is a RETURN wording, never a delivery).
 * - STATUS_MAP gains ASSIGNED_TO_COURIER → order IN_TRANSIT (no customer
 *   WhatsApp — that waits for the courier's actual OFD scan).
 * - Sync + WhatsApp triggers run on the normalized key.
 *
 * The REAL flaship service, REAL orders service (changeOrderStatus) and REAL
 * whatsapp fan-out run against a mocked store; live tracking responses are
 * served by a stubbed global fetch so the whole liveRequest → parse →
 * normalize → map → persist → notify path is exercised end-to-end.
 */
import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";

mock.module("server-only", () => ({}));

// Live mode without touching the encrypted-settings path (env key wins).
const PREV_FLASHIP_KEY = process.env.FLASHIP_API_KEY;
process.env.FLASHIP_API_KEY = "test-integration-key";

const inventoryCalls = { release: 0, restore: 0, finalize: 0 };
const commissionCalls: string[] = [];

mock.module("@/lib/services/inventory", () => ({
  applyMovement: async () => undefined,
  reserveForOrder: async () => undefined,
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

// ---- store fake -------------------------------------------------------------
type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {
  orders: [],
  customers: [],
  shipments: [],
  shipment_tracking: [],
  order_status_history: [],
  flaship_logs: [],
  settings: [],
  whatsapp_routing_settings: [], // empty → enabled defaults + default templates
  whatsapp_bot_settings: [{ id: "ws-1", max_retries: 3 }],
  whatsapp_message_queue: [],
  whatsapp_admin_recipients: [],
  whatsapp_group_settings: [],
};

mock.module("@/lib/store", () => ({
  IS_DEMO_MODE: false,
  store: {
    get: async (table: string, id: string) => (db[table] ?? []).find((r) => r.id === id) ?? null,
    first: async (table: string, filters: Record<string, unknown> = {}) => {
      let rows = db[table] ?? [];
      for (const [k, v] of Object.entries(filters)) rows = rows.filter((r) => r[k] === v);
      return rows[0] ?? null;
    },
    list: async (
      table: string,
      opts?: { filters?: Record<string, unknown>; orderBy?: { field: string; dir: "asc" | "desc" }; perPage?: number }
    ) => {
      let rows = [...(db[table] ?? [])];
      for (const [k, v] of Object.entries(opts?.filters ?? {})) rows = rows.filter((r) => r[k] === v);
      if (opts?.orderBy) {
        const dir = opts.orderBy.dir === "desc" ? -1 : 1;
        rows.sort((a, b) => (String(a[opts.orderBy!.field] ?? "") < String(b[opts.orderBy!.field] ?? "") ? -dir : dir));
      }
      if (opts?.perPage) rows = rows.slice(0, opts.perPage);
      return { rows, total: rows.length };
    },
    update: async (table: string, id: string, data: Record<string, unknown>) => {
      const row = (db[table] ?? []).find((r) => r.id === id);
      if (row) Object.assign(row, data);
      return { id, ...data };
    },
    insert: async (table: string, payload: Record<string, unknown>) => {
      const row = { id: `new-${table}-${(db[table]?.length ?? 0) + 1}`, ...payload };
      if (!db[table]) db[table] = [];
      db[table].push(row);
      return row;
    },
    delete: async () => undefined,
  },
}));

// Real whatsapp fan-out behind a recording delegating wrapper, then the real
// orders service and the real flaship service (the "?real" convention — other
// suite files mock these specifiers with partial fakes).
const REAL_WHATSAPP = "../src/lib/services/whatsapp?real";
const { enqueueWhatsAppOrderEvent } = await import(REAL_WHATSAPP);
const enqueueCalls: { orderId: string; type: string }[] = [];
mock.module("@/lib/services/whatsapp", () => ({
  enqueueWhatsAppOrderEvent: async (params: { orderId: string; type: string }) => {
    enqueueCalls.push(params);
    return enqueueWhatsAppOrderEvent(params);
  },
}));
const REAL_ORDERS = "../src/lib/services/orders?real";
const { changeOrderStatus } = await import(REAL_ORDERS) as { changeOrderStatus: (s: unknown, id: string, st: string, note?: string) => Promise<Row> };
const REAL_FLASHIP = "../src/lib/flaship/service?real";
const flaship = await import(REAL_FLASHIP) as {
  syncOrderTracking: (s: unknown, orderId: string) => Promise<{ applied: boolean; message: string }>;
  normalizeCourierStatus: (raw: unknown) => string;
};

// ---- stubbed Flaship live tracking endpoint --------------------------------
let fixture: unknown = null;
const REAL_FETCH = globalThis.fetch;
globalThis.fetch = (async () =>
  new Response(JSON.stringify(fixture ?? { success: true, data: {} }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })) as unknown as typeof fetch;

afterAll(() => {
  globalThis.fetch = REAL_FETCH;
  if (PREV_FLASHIP_KEY === undefined) delete process.env.FLASHIP_API_KEY;
  else process.env.FLASHIP_API_KEY = PREV_FLASHIP_KEY;
});

// ---- fixtures ----------------------------------------------------------------
function seedBookedOrder(status = "BOOKED"): Row {
  const order: Row = {
    id: "o-leo",
    order_number: "RC-LEO",
    status,
    booking_status: "booked",
    tracking_number: "OK7546914590",
    flaship_booking_id: "FB-LEO-1",
    flaship_courier_name: "Leopard",
    customer_id: "c-1",
    total: 1500,
    city: "Sargodha",
    last_synced_at: null,
  };
  db.orders = [order];
  db.customers = [{ id: "c-1", name: "Ali Raza", phone: "03001234567" }];
  return order;
}

/** Realistic Flaship tracking payload (wrapper + newest-first history). */
function trackingPayload(orderStatus: string, events: { status: string; description?: string | null; location?: string | null; datetime: string }[]) {
  fixture = {
    success: true,
    data: { tracking_number: "OK7546914590", order_status: orderStatus, tracking_history: events },
  };
}

const LEO_EVENTS = [
  { status: "ASSIGNED TO COURIER IN SARGODHA", description: "Shipment assigned to delivery courier", location: "SARGODHA", datetime: "2026-10-22T15:02:00+05:00" },
  { status: "IN TRANSIT TO SARGODHA", description: "Shipment moving to destination hub", location: "LAHORE", datetime: "2026-10-21T18:30:00+05:00" },
];

const queueRows = () => db.whatsapp_message_queue as { notification_type: string; recipient: string; status: string; dedupe_key: string }[];
const trackingRows = () => db.shipment_tracking as { status: string; scanned_at: string }[];

beforeEach(() => {
  inventoryCalls.release = 0; inventoryCalls.restore = 0; inventoryCalls.finalize = 0;
  commissionCalls.length = 0;
  enqueueCalls.length = 0;
  fixture = null;
  for (const t of Object.keys(db)) {
    if (t === "whatsapp_bot_settings") continue;
    db[t] = [];
  }
  db.whatsapp_bot_settings = [{ id: "ws-1", max_retries: 3 }];
});

// ---------------------------------------------------------------- unit tests
describe("normalizeCourierStatus — verified Leopards vocabulary → canonical keys", () => {
  it("maps the reported Leopard scan to the pre-OFD key, never to OUT_FOR_DELIVERY", () => {
    expect(flaship.normalizeCourierStatus("ASSIGNED TO COURIER IN SARGODHA")).toBe("ASSIGNED_TO_COURIER");
    expect(flaship.normalizeCourierStatus("Assigned to courier in Sargodha")).toBe("ASSIGNED_TO_COURIER");
    // Leopards' own next scan is a distinct "Out for Delivery" — the assigned
    // scan must never collapse into it (no premature customer message).
    expect(flaship.normalizeCourierStatus("ASSIGNED TO COURIER IN SARGODHA")).not.toBe("OUT_FOR_DELIVERY");
  });

  it("maps transit / pickup / booking spellings", () => {
    expect(flaship.normalizeCourierStatus("SHIPMENT PICKED IN LAHORE")).toBe("PICKED_UP");
    expect(flaship.normalizeCourierStatus("PICKED UP")).toBe("PICKED_UP");
    expect(flaship.normalizeCourierStatus("IN TRANSIT TO SARGODHA")).toBe("IN_TRANSIT");
    expect(flaship.normalizeCourierStatus("DISPATCHED TO SARGODHA")).toBe("IN_TRANSIT");
    expect(flaship.normalizeCourierStatus("ARRIVED AT STATION IN MULTAN")).toBe("IN_TRANSIT");
    expect(flaship.normalizeCourierStatus("BOOKED")).toBe("BOOKED");
    expect(flaship.normalizeCourierStatus("PICKUP REQUEST SENT")).toBe("BOOKED");
  });

  it("treats 'Delivered to Warehouse/Vendor' as a RETURN, never a delivery", () => {
    expect(flaship.normalizeCourierStatus("DELIVERED TO WAREHOUSE")).toBe("RETURN_TO_SHIPPER");
    expect(flaship.normalizeCourierStatus("DELIVERED TO VENDOR IN LAHORE")).toBe("RETURN_TO_SHIPPER");
    expect(flaship.normalizeCourierStatus("RETURNED TO SHIPPER")).toBe("RETURN_TO_SHIPPER");
    expect(flaship.normalizeCourierStatus("RETURN TO ORIGIN")).toBe("RETURN_TO_SHIPPER");
    expect(flaship.normalizeCourierStatus("RTO INTRANSIT")).toBe("RTO_INTRANSIT"); // canonical fast path
    expect(flaship.normalizeCourierStatus("RETURNED")).toBe("RETURNED");
  });

  it("keeps canonical and unknown statuses workable (no behaviour change)", () => {
    expect(flaship.normalizeCourierStatus("OUT_FOR_DELIVERY")).toBe("OUT_FOR_DELIVERY");
    expect(flaship.normalizeCourierStatus("OUT FOR DELIVERY")).toBe("OUT_FOR_DELIVERY");
    expect(flaship.normalizeCourierStatus("DELIVERED")).toBe("DELIVERED");
    expect(flaship.normalizeCourierStatus("CANCELLED")).toBe("CANCELLED");
    // Leopards "Pending" = failed attempt — deliberately unmapped.
    expect(flaship.normalizeCourierStatus("PENDING")).toBe("PENDING");
    expect(flaship.normalizeCourierStatus("SOME UNKNOWN SCAN 42")).toBe("SOME_UNKNOWN_SCAN_42");
    expect(flaship.normalizeCourierStatus("")).toBe("");
    expect(flaship.normalizeCourierStatus(null)).toBe("");
  });
});

// ------------------------------------------------------------- end-to-end ---
describe("syncOrderTracking — Leopard 'ASSIGNED TO COURIER IN SARGODHA' (reported bug)", () => {
  it("advances a BOOKED order to IN_TRANSIT, keeps raw checkpoints, sends no customer WhatsApp", async () => {
    seedBookedOrder();
    trackingPayload("ASSIGNED TO COURIER IN SARGODHA", LEO_EVENTS);

    const r = await flaship.syncOrderTracking(null, "o-leo");

    expect(r.applied).toBe(true);
    expect(r.message).toContain("Assigned to courier");
    expect((db.orders[0] as Row).status).toBe("IN_TRANSIT");
    // checkpoints store the RAW courier strings (display fidelity), newest event persisted too
    expect(trackingRows().map((c) => c.status)).toEqual(
      expect.arrayContaining(["ASSIGNED TO COURIER IN SARGODHA", "IN TRANSIT TO SARGODHA"])
    );
    // rider-assigned scan is pre-OFD → no customer message yet
    expect(enqueueCalls).toHaveLength(0);
    expect(queueRows()).toHaveLength(0);
  });

  it("reports 'Tracking is up to date.' only after everything is genuinely synced (idempotent re-sync)", async () => {
    seedBookedOrder();
    trackingPayload("ASSIGNED TO COURIER IN SARGODHA", LEO_EVENTS);
    await flaship.syncOrderTracking(null, "o-leo");

    const r2 = await flaship.syncOrderTracking(null, "o-leo");

    expect(r2.applied).toBe(false);
    expect(r2.message).toBe("Tracking is up to date.");
    expect(trackingRows()).toHaveLength(2); // no duplicate checkpoints (status+date dedupe)
    expect((db.orders[0] as Row).status).toBe("IN_TRANSIT");
    expect(queueRows()).toHaveLength(0);
  });
});

describe("syncOrderTracking — OUT FOR DELIVERY customer notification (dedupe)", () => {
  it("enqueues exactly one customer message for the free-text scan, and re-syncs never duplicate it", async () => {
    seedBookedOrder("IN_TRANSIT"); // Leopard scans OFD after the rider-assigned step
    trackingPayload("OUT FOR DELIVERY", [
      { status: "OUT FOR DELIVERY", description: "Out for delivery", location: "SARGODHA", datetime: "2026-10-22T16:10:00+05:00" },
      { status: "ASSIGNED TO COURIER IN SARGODHA", description: null, location: "SARGODHA", datetime: "2026-10-22T15:02:00+05:00" },
    ]);

    const r = await flaship.syncOrderTracking(null, "o-leo");

    expect(r.applied).toBe(false); // order already IN_TRANSIT — OFD never changes it
    const ofd = queueRows().filter((q) => q.notification_type === "OUT_FOR_DELIVERY");
    expect(ofd).toHaveLength(1);
    expect(ofd[0].recipient).toBe("923001234567"); // normalized PK WhatsApp digits
    expect(ofd[0].status).toBe("pending");
    expect(ofd[0].dedupe_key).toBe("o-leo:OUT_FOR_DELIVERY:923001234567");

    await flaship.syncOrderTracking(null, "o-leo"); // cron/manual repeat
    expect(queueRows().filter((q) => q.notification_type === "OUT_FOR_DELIVERY")).toHaveLength(1);
  });
});

describe("syncOrderTracking — return wordings and terminal scans", () => {
  it("'DELIVERED TO WAREHOUSE' marks the order RETURNED (never DELIVERED) and alerts the Flaship group", async () => {
    seedBookedOrder("IN_TRANSIT");
    trackingPayload("DELIVERED TO WAREHOUSE IN LAHORE", [
      { status: "DELIVERED TO WAREHOUSE IN LAHORE", description: "Return received at merchant warehouse", location: "LAHORE", datetime: "2026-10-22T09:00:00+05:00" },
    ]);

    const r = await flaship.syncOrderTracking(null, "o-leo");

    expect(r.applied).toBe(true);
    expect((db.orders[0] as Row).status).toBe("RETURNED");
    expect(queueRows().some((q) => q.notification_type === "DELIVERED")).toBe(false);
    // SHIPPER_ADVISE fans out to groups; none configured → recorded once as failed
    const adv = queueRows().filter((q) => q.notification_type === "SHIPPER_ADVISE");
    expect(adv).toHaveLength(1);
    expect(adv[0].status).toBe("failed");
    expect(commissionCalls).toEqual(["RETURNED"]);
    expect(inventoryCalls.release).toBe(1); // never-delivered order → reservation released
  });

  it("plain DELIVERED notifies the customer exactly once across repeated syncs", async () => {
    seedBookedOrder("IN_TRANSIT");
    trackingPayload("DELIVERED", [
      { status: "DELIVERED", description: "Delivered — COD collected", location: "SARGODHA", datetime: "2026-10-22T12:00:00+05:00" },
    ]);

    const r = await flaship.syncOrderTracking(null, "o-leo");
    expect(r.applied).toBe(true);
    expect((db.orders[0] as Row).status).toBe("DELIVERED");
    expect(queueRows().filter((q) => q.notification_type === "DELIVERED")).toHaveLength(1);

    await flaship.syncOrderTracking(null, "o-leo");
    expect(queueRows().filter((q) => q.notification_type === "DELIVERED")).toHaveLength(1); // dedupe holds
  });

  it("Leopard 'PENDING' (failed attempt) saves the checkpoint but changes no order status", async () => {
    seedBookedOrder();
    trackingPayload("PENDING", [
      { status: "PENDING", description: "Delivery attempt failed — will retry", location: "SARGODHA", datetime: "2026-10-22T17:30:00+05:00" },
    ]);

    const r = await flaship.syncOrderTracking(null, "o-leo");

    expect(r.applied).toBe(false);
    expect(r.message).toContain("1 new tracking checkpoint");
    expect((db.orders[0] as Row).status).toBe("BOOKED");
    expect(queueRows()).toHaveLength(0);
  });
});

describe("changeOrderStatus integration (real orders service)", () => {
  it("still enforces the transition map on auto-synced changes", async () => {
    seedBookedOrder("BOOKED");
    await expect(changeOrderStatus({ userId: "system" }, "o-leo", "DELIVERED", "skip")).rejects.toThrow(
      /Cannot change status from BOOKED to DELIVERED/
    );
  });
});
