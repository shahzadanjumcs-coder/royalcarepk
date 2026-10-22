/// <reference types="bun-types" />
/**
 * Authoritative Flaship shipment-status regressions (2026-10 OFD sync bug).
 *
 * VERIFIED PRODUCTION EVIDENCE — Flaship tracking endpoint (HTTP 200, success:true):
 *   {
 *     "success": true,
 *     "tracking_number": "OK7546914590",
 *     "status": "OUT_FOR_DELIVERY",                      ← AUTHORITATIVE shipment status
 *     "live_courier_status": "Assigned to courier in SARGODHA",  ← raw courier scan
 *     "tracking": [ { "status": "Assigned to courier in SARGODHA",
 *                     "time": "2026-10-22 10:02:27" } ],
 *     "message": null
 *   }
 * Same shape for OK7546912576 (LIAQATPUR). Flaship showed both shipments as
 * OUT_FOR_DELIVERY, but RoyalCarePK kept them IN_TRANSIT and no customer
 * Out-for-Delivery WhatsApp was ever enqueued.
 *
 * Root cause fixed here: extractLatestStatus()'s ?? chain gave the raw courier
 * scan (live_courier_status) precedence over the authoritative top-level
 * `status`, so the response parsed as "ASSIGNED TO COURIER …" (pre-OFD) and the
 * customer OFD trigger never fired.
 *
 * Under test:
 *   - extractTrackingStatusFields(): typed canonical layer separating
 *     1) authoritative shipment status, 2) raw courier scan, 3) history events.
 *   - Precedence: recognized authoritative `status` wins over the courier scan;
 *     an unrecognized/unknown status NEVER silently classifies as
 *     DELIVERED/CANCELLED/OUT_FOR_DELIVERY and defers to the courier scan.
 *   - "Assigned to courier" alone never triggers Out-for-Delivery.
 *   - Exactly-once WhatsApp: repeated syncs, concurrent syncs and
 *     already-stored raw checkpoints never duplicate the notification.
 *   - Out-of-order protection: stale statuses cannot regress the order.
 *   - Unknown / null / malformed / nested responses fail safely.
 *
 * The REAL flaship service, REAL orders service (changeOrderStatus) and REAL
 * whatsapp fan-out run against a mocked store; live tracking responses are
 * served by a stubbed global fetch. NO real WhatsApp message can be sent — the
 * queue is only a table in the fake store and the bot is never started.
 */
import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";

mock.module("server-only", () => ({}));

// Live mode without touching the encrypted-settings path (env key wins).
const PREV_FLASHIP_KEY = process.env.FLASHIP_API_KEY;
process.env.FLASHIP_API_KEY = "test-integration-key";

const inventoryCalls = { release: 0, restore: 0, finalize: 0 };

mock.module("@/lib/services/inventory", () => ({
  applyMovement: async () => undefined,
  reserveForOrder: async () => undefined,
  finalizeForOrder: async () => { inventoryCalls.finalize += 1; },
  restoreForOrder: async () => { inventoryCalls.restore += 1; },
  releaseForOrder: async () => { inventoryCalls.release += 1; },
}));
mock.module("@/lib/services/commission", () => ({
  processCommissionForStatus: async () => undefined,
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
      // Emulate the production UNIQUE constraint on whatsapp_message_queue
      // (migration 0004: dedupe_key text not null unique) so the concurrency
      // test exercises the real 23505-handling path in enqueueRow().
      if (table === "whatsapp_message_queue" && typeof payload.dedupe_key === "string") {
        const clash = (db.whatsapp_message_queue ?? []).some((r) => r.dedupe_key === payload.dedupe_key);
        if (clash) {
          throw new Error('duplicate key value violates unique constraint "whatsapp_message_queue_dedupe_key_key"');
        }
      }
      const row = { id: `new-${table}-${(db[table]?.length ?? 0) + 1}`, ...payload };
      if (!db[table]) db[table] = [];
      db[table].push(row);
      return row;
    },
    delete: async () => undefined,
  },
}));

// Real whatsapp fan-out behind a recording delegating wrapper, then the real
// orders service and the real flaship service (the "?real" convention).
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
  extractTrackingStatusFields: (payload: Record<string, unknown>) => { shipmentStatus: string | null; courierStatus: string | null };
};

// ---- stubbed Flaship live tracking endpoint --------------------------------
let fixture: unknown = null;
const REAL_FETCH = globalThis.fetch;
globalThis.fetch = (async () =>
  new Response(typeof fixture === "string" ? fixture : JSON.stringify(fixture ?? { success: true, data: {} }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })) as unknown as typeof fetch;

afterAll(() => {
  globalThis.fetch = REAL_FETCH;
  if (PREV_FLASHIP_KEY === undefined) delete process.env.FLASHIP_API_KEY;
  else process.env.FLASHIP_API_KEY = PREV_FLASHIP_KEY;
});

// ---- verified production response shapes (exact, from the 2026-10 evidence) --
const SCAN_SARGODHA = "Assigned to courier in SARGODHA";
const SCAN_LIAQATPUR = "Assigned to courier in LIAQATPUR";

function verifiedResponse(cn: string, scan: string): Record<string, unknown> {
  return {
    success: true,
    tracking_number: cn,
    status: "OUT_FOR_DELIVERY",
    live_courier_status: scan,
    tracking: [{ status: scan, time: "2026-10-22 10:02:27" }],
    message: null,
  };
}
const VERIFIED_4590 = verifiedResponse("OK7546914590", SCAN_SARGODHA);
const VERIFIED_2576 = verifiedResponse("OK7546912576", SCAN_LIAQATPUR);

/** Same instant the parser derives from the raw "2026-10-22 10:02:27" stamp. */
const EVENT_ISO = new Date("2026-10-22 10:02:27").toISOString();

// ---- fixtures ----------------------------------------------------------------
let orderSeq = 0;
function seedOrder(status = "IN_TRANSIT", cn = "OK7546914590"): Row {
  orderSeq += 1;
  const order: Row = {
    id: `o-ofd-${orderSeq}`,
    order_number: `RC-OFD-${orderSeq}`,
    status,
    booking_status: "booked",
    tracking_number: cn,
    flaship_booking_id: `FB-${orderSeq}`,
    flaship_courier_name: "Leopard",
    customer_id: "c-1",
    total: 1500,
    city: "Sargodha",
    last_synced_at: null,
  };
  db.orders = [order];
  db.customers = [{ id: "c-1", name: "Ali Raza", phone: "03001234567" }];
  db.shipments = [{
    id: `sh-${orderSeq}`,
    order_id: order.id,
    courier_name: "Leopard",
    tracking_number: cn,
    booking_id: `FB-${orderSeq}`,
    destination_city: "Sargodha",
    pickup_location: "LHR-01",
    shipment_status: "BOOKED",
    booked_at: "2026-10-20T10:00:00.000Z",
    last_synced_at: null,
  }];
  return order;
}

/** Wrapper-style payload the app has always supported (simulator shape). */
function wrappedPayload(orderStatus: string, events: { status: string; datetime: string }[]): Record<string, unknown> {
  return { success: true, data: { tracking_number: "OK7546914590", order_status: orderStatus, tracking_history: events } };
}

const queueRows = () => db.whatsapp_message_queue as { notification_type: string; recipient: string; status: string; dedupe_key: string; max_retries: number }[];
const ofdRows = () => queueRows().filter((q) => q.notification_type === "OUT_FOR_DELIVERY");
const trackingRows = () => db.shipment_tracking as { status: string; scanned_at: string }[];

beforeEach(() => {
  inventoryCalls.release = 0; inventoryCalls.restore = 0; inventoryCalls.finalize = 0;
  enqueueCalls.length = 0;
  fixture = null;
  for (const t of Object.keys(db)) {
    if (t === "whatsapp_bot_settings") continue;
    db[t] = [];
  }
  db.whatsapp_bot_settings = [{ id: "ws-1", max_retries: 3 }];
});

// ------------------------------------------------- canonical layer (unit) ----
describe("extractTrackingStatusFields — typed normalization layer", () => {
  it("separates the authoritative shipment status from the raw courier scan (verified shape)", () => {
    const f = flaship.extractTrackingStatusFields(VERIFIED_4590);
    expect(f.shipmentStatus).toBe("OUT_FOR_DELIVERY");
    expect(f.courierStatus).toBe(SCAN_SARGODHA); // ORIGINAL casing preserved
  });

  it("normalizes casing/underscores/hyphens without destroying raw values", () => {
    const f = flaship.extractTrackingStatusFields({ status: "out-for-delivery", live_courier_status: "Assigned to courier in SARGODHA" });
    expect(f.shipmentStatus).toBe("OUT_FOR_DELIVERY");
    expect(f.courierStatus).toBe("Assigned to courier in SARGODHA");
  });

  it("order_status stays the highest-precedence authoritative field", () => {
    const f = flaship.extractTrackingStatusFields({ order_status: "IN_TRANSIT", status: "OUT_FOR_DELIVERY", live_courier_status: "Out for delivery" });
    expect(f.shipmentStatus).toBe("IN_TRANSIT");
  });

  it("never treats success flags or unknown text as an authoritative status", () => {
    for (const s of ["success", "ok", "true", "error", "failed", "CHECKPOINT 42"]) {
      const f = flaship.extractTrackingStatusFields({ status: s, live_courier_status: SCAN_SARGODHA });
      expect(f.shipmentStatus).toBeNull();
      expect(f.courierStatus).toBe(SCAN_SARGODHA); // defers to the courier scan
    }
  });

  it("returns nulls for empty payloads (safe pass-through)", () => {
    expect(flaship.extractTrackingStatusFields({})).toEqual({ shipmentStatus: null, courierStatus: null });
    expect(flaship.extractTrackingStatusFields({ status: "   ", live_courier_status: "" })).toEqual({ shipmentStatus: null, courierStatus: null });
  });
});

// ------------------------------- verified CN OK7546914590 (end-to-end) -------
describe("syncOrderTracking — verified CN OK7546914590 (SARGODHA)", () => {
  it("fires exactly one Out-for-Delivery WhatsApp on the authoritative status; order stays IN_TRANSIT", async () => {
    const order = seedOrder("IN_TRANSIT", "OK7546914590");
    fixture = VERIFIED_4590;

    const r = await flaship.syncOrderTracking(null, order.id as string);

    expect(r.applied).toBe(false); // OFD is a courier event — order stays IN_TRANSIT (existing contract)
    expect((db.orders[0] as Row).status).toBe("IN_TRANSIT");
    expect(ofdRows()).toHaveLength(1);
    expect(ofdRows()[0].recipient).toBe("923001234567"); // normalized customer digits
    expect(ofdRows()[0].status).toBe("pending"); // queued ≠ sent — bot owns delivery state
    expect(ofdRows()[0].max_retries).toBe(3); // existing retry policy untouched
    expect(ofdRows()[0].dedupe_key).toBe(`${order.id}:OUT_FOR_DELIVERY:923001234567`);
    expect(enqueueCalls).toEqual([{ orderId: order.id as string, type: "OUT_FOR_DELIVERY" }]);
  });

  it("keeps the raw courier scan for display/diagnostics (checkpoint + shipment_status)", async () => {
    const order = seedOrder("IN_TRANSIT", "OK7546914590");
    fixture = VERIFIED_4590;

    await flaship.syncOrderTracking(null, order.id as string);

    // history event stored verbatim (uppercased by the checkpoint layer) with its timestamp
    expect(trackingRows()).toHaveLength(1);
    expect(trackingRows()[0].status).toBe("ASSIGNED TO COURIER IN SARGODHA");
    expect(trackingRows()[0].scanned_at).toBe(EVENT_ISO);
    // shipment row keeps the verbatim raw scan text
    expect((db.shipments[0] as Row).shipment_status).toBe(SCAN_SARGODHA);
  });

  it("repeated syncs never duplicate the notification (idempotent)", async () => {
    const order = seedOrder("IN_TRANSIT", "OK7546914590");
    fixture = VERIFIED_4590;

    await flaship.syncOrderTracking(null, order.id as string);
    const r2 = await flaship.syncOrderTracking(null, order.id as string);
    const r3 = await flaship.syncOrderTracking(null, order.id as string);

    expect(r2.applied).toBe(false);
    expect(r3.message).toBe("Tracking is up to date.");
    expect(trackingRows()).toHaveLength(1); // status+date checkpoint dedupe
    expect(ofdRows()).toHaveLength(1); // dedupe_key UNIQUE holds
  });
});

// ------------------------------- verified CN OK7546912576 (end-to-end) -------
describe("syncOrderTracking — verified CN OK7546912576 (LIAQATPUR)", () => {
  it("fires exactly one Out-for-Delivery WhatsApp on the authoritative status", async () => {
    const order = seedOrder("IN_TRANSIT", "OK7546912576");
    fixture = VERIFIED_2576;

    const r = await flaship.syncOrderTracking(null, order.id as string);

    expect(r.applied).toBe(false);
    expect((db.orders[0] as Row).status).toBe("IN_TRANSIT");
    expect(ofdRows()).toHaveLength(1);
    expect(trackingRows()[0].status).toBe("ASSIGNED TO COURIER IN LIAQATPUR");
    expect((db.shipments[0] as Row).shipment_status).toBe(SCAN_LIAQATPUR);
  });
});

// ----------------------------------------- reconciliation of affected CNs ----
describe("reconciliation — raw checkpoint already stored by the buggy sync", () => {
  it("a previously stored raw checkpoint does NOT suppress the missing OFD notification", async () => {
    const order = seedOrder("IN_TRANSIT", "OK7546914590");
    // What production stored before the fix: the raw courier scan as a
    // checkpoint, no WhatsApp message, order left IN_TRANSIT.
    db.shipment_tracking = [{
      id: "cp-old",
      order_id: order.id,
      shipment_id: (db.shipments[0] as Row).id,
      status: "ASSIGNED TO COURIER IN SARGODHA",
      description: null,
      location: null,
      scanned_at: EVENT_ISO,
    }];
    fixture = VERIFIED_4590;

    const r = await flaship.syncOrderTracking(null, order.id as string);

    // checkpoint deduped (status+date) AND the authoritative notification still fires — once
    expect(trackingRows()).toHaveLength(1);
    expect(ofdRows()).toHaveLength(1);
    expect(r.applied).toBe(false);
    expect(r.message).toBe("Tracking is up to date.");
  });

  it("re-syncing after reconciliation keeps exactly one notification (no resend)", async () => {
    const order = seedOrder("IN_TRANSIT", "OK7546914590");
    db.shipment_tracking = [{
      id: "cp-old",
      order_id: order.id,
      shipment_id: (db.shipments[0] as Row).id,
      status: "ASSIGNED TO COURIER IN SARGODHA",
      description: null,
      location: null,
      scanned_at: EVENT_ISO,
    }];
    fixture = VERIFIED_4590;
    await flaship.syncOrderTracking(null, order.id as string);

    await flaship.syncOrderTracking(null, order.id as string);

    expect(ofdRows()).toHaveLength(1);
    expect(queueRows()).toHaveLength(1); // no booking/delivered/return side effects either
  });
});

// --------------------------------------------- precedence & safety rules -----
describe("precedence — authoritative status vs raw courier scan", () => {
  it("ASSIGNED TO COURIER alone never triggers Out-for-Delivery", async () => {
    const order = seedOrder("BOOKED", "OK7546914590");
    fixture = {
      success: true,
      live_courier_status: SCAN_SARGODHA,
      tracking: [{ status: SCAN_SARGODHA, time: "2026-10-22 10:02:27" }],
    };

    const r = await flaship.syncOrderTracking(null, order.id as string);

    expect(r.applied).toBe(true); // pre-OFD rider assignment → IN_TRANSIT (existing mapping)
    expect((db.orders[0] as Row).status).toBe("IN_TRANSIT");
    expect(ofdRows()).toHaveLength(0);
    expect(queueRows()).toHaveLength(0);
  });

  it("authoritative DELIVERED wins over an 'Out for delivery' courier scan", async () => {
    const order = seedOrder("IN_TRANSIT", "OK7546914590");
    fixture = {
      success: true,
      status: "DELIVERED",
      live_courier_status: "Out for delivery",
      tracking: [{ status: "Out for delivery", time: "2026-10-21 09:00:00" }],
    };

    const r = await flaship.syncOrderTracking(null, order.id as string);

    expect(r.applied).toBe(true);
    expect((db.orders[0] as Row).status).toBe("DELIVERED");
    expect(ofdRows()).toHaveLength(0);
    expect(queueRows().filter((q) => q.notification_type === "DELIVERED")).toHaveLength(1);
  });

  it("authoritative IN_TRANSIT suppresses a courier-driven OFD trigger (no premature message)", async () => {
    const order = seedOrder("IN_TRANSIT", "OK7546914590");
    fixture = {
      success: true,
      status: "IN_TRANSIT",
      live_courier_status: "Out for delivery",
      tracking: [{ status: "Out for delivery", time: "2026-10-22 09:00:00" }],
    };

    await flaship.syncOrderTracking(null, order.id as string);

    expect((db.orders[0] as Row).status).toBe("IN_TRANSIT");
    expect(ofdRows()).toHaveLength(0);
  });

  it("unknown authoritative status defers to the courier scan and never fabricates OFD/DELIVERED", async () => {
    const order = seedOrder("BOOKED", "OK7546914590");
    fixture = {
      success: true,
      status: "CHECKPOINT 42",
      live_courier_status: SCAN_SARGODHA,
      tracking: [{ status: SCAN_SARGODHA, time: "2026-10-22 10:02:27" }],
    };

    const r = await flaship.syncOrderTracking(null, order.id as string);

    expect((db.orders[0] as Row).status).toBe("IN_TRANSIT"); // courier scan drives (pre-existing semantics)
    expect(ofdRows()).toHaveLength(0);
    expect(trackingRows()[0].status).toBe("ASSIGNED TO COURIER IN SARGODHA"); // raw preserved
  });

  it("handles nested response wrappers the app already supports", async () => {
    const order = seedOrder("IN_TRANSIT", "OK7546914590");
    fixture = { success: true, data: { ...VERIFIED_4590 } };

    await flaship.syncOrderTracking(null, order.id as string);

    expect(ofdRows()).toHaveLength(1);
    expect((db.orders[0] as Row).status).toBe("IN_TRANSIT");
  });
});

// ------------------------------------------- exactly-once under concurrency ---
describe("concurrency — parallel sync attempts", () => {
  it("two concurrent syncs of the same response create exactly one WhatsApp notification", async () => {
    const order = seedOrder("IN_TRANSIT", "OK7546914590");
    fixture = VERIFIED_4590;

    await Promise.all([
      flaship.syncOrderTracking(null, order.id as string),
      flaship.syncOrderTracking(null, order.id as string),
    ]);

    expect(ofdRows()).toHaveLength(1); // pre-check + emulated 23505 unique-violation path held
    expect(enqueueCalls.filter((c) => c.type === "OUT_FOR_DELIVERY")).toHaveLength(2); // both syncs attempted the trigger…
  });
});

// --------------------------------------------- out-of-order regression guard --
describe("out-of-order protection — stale statuses cannot regress the order", () => {
  it("stale IN_TRANSIT response on a DELIVERED order keeps the newer order status (no throw)", async () => {
    const order = seedOrder("DELIVERED", "OK7546914590");
    fixture = {
      success: true,
      status: "IN_TRANSIT",
      live_courier_status: SCAN_SARGODHA,
      tracking: [{ status: SCAN_SARGODHA, time: "2026-10-22 10:02:27" }],
    };

    const r = await flaship.syncOrderTracking(null, order.id as string);

    expect(r.applied).toBe(false);
    expect(r.message).toContain("keeping the newer order status");
    expect((db.orders[0] as Row).status).toBe("DELIVERED");
  });

  it("a DELIVERED auto-transition from BOOKED is reported, not applied, and does not throw", async () => {
    const order = seedOrder("BOOKED", "OK7546914590");
    fixture = { success: true, status: "DELIVERED", tracking: [{ status: "DELIVERED", time: "2026-10-22 09:00:00" }] };

    const r = await flaship.syncOrderTracking(null, order.id as string);

    expect(r.applied).toBe(false);
    expect(r.message).toContain("keeping the newer order status");
    expect((db.orders[0] as Row).status).toBe("BOOKED");
    expect(queueRows().filter((q) => q.notification_type === "DELIVERED")).toHaveLength(0);
  });
});

// --------------------------------------------- safe failure handling ----------
describe("unknown / null / malformed responses fail safely", () => {
  it("non-JSON (gateway HTML) body never throws and changes nothing", async () => {
    const order = seedOrder("IN_TRANSIT", "OK7546914590");
    fixture = "<html>Gateway Timeout Error</html>";

    const r = await flaship.syncOrderTracking(null, order.id as string);

    expect(r.applied).toBe(false);
    expect((db.orders[0] as Row).status).toBe("IN_TRANSIT");
    expect(queueRows()).toHaveLength(0);
    expect(trackingRows()).toHaveLength(0);
  });

  it("JSON null body never throws", async () => {
    const order = seedOrder("IN_TRANSIT", "OK7546914590");
    fixture = "null";

    const r = await flaship.syncOrderTracking(null, order.id as string);

    expect(r.applied).toBe(false);
    expect(queueRows()).toHaveLength(0);
  });

  it("empty object payload is a no-op", async () => {
    const order = seedOrder("IN_TRANSIT", "OK7546914590");
    fixture = {};

    const r = await flaship.syncOrderTracking(null, order.id as string);

    expect(r.applied).toBe(false);
    expect(r.message).toBe("Tracking is up to date.");
    expect(queueRows()).toHaveLength(0);
  });

  it("Leopard 'PENDING' (failed attempt) stays unmapped — no customer message", async () => {
    const order = seedOrder("IN_TRANSIT", "OK7546914590");
    fixture = { success: true, status: "PENDING", tracking: [{ status: "PENDING", time: "2026-10-22 17:30:00" }] };

    const r = await flaship.syncOrderTracking(null, order.id as string);

    expect(r.applied).toBe(false);
    expect((db.orders[0] as Row).status).toBe("IN_TRANSIT");
    expect(queueRows()).toHaveLength(0);
    expect(trackingRows()[0].status).toBe("PENDING"); // unknown stays intact in checkpoints
  });
});

// ------------------------------------- existing mappings remain correct -------
describe("existing status mappings remain correct (authoritative order_status style)", () => {
  it("BOOKED / PICKED_UP / IN_TRANSIT keep their meaning", async () => {
    const o1 = seedOrder("BOOKED", "OK7546914590");
    fixture = wrappedPayload("PICKED_UP", [{ status: "PICKED_UP", datetime: "2026-10-21T10:00:00+05:00" }]);
    await flaship.syncOrderTracking(null, o1.id as string);
    expect((db.orders[0] as Row).status).toBe("IN_TRANSIT");

    const o2 = seedOrder("BOOKED", "OK7546912576");
    fixture = wrappedPayload("BOOKED", [{ status: "BOOKED", datetime: "2026-10-20T10:00:00+05:00" }]);
    const r = await flaship.syncOrderTracking(null, o2.id as string);
    expect((db.orders[0] as Row).status).toBe("BOOKED"); // BOOKED never regresses to a courier state
    expect(r.message).toContain("1 new tracking checkpoint");
  });

  it("RTO / RETURNED wordings still mark the order RETURNED and alert the right channels", async () => {
    const order = seedOrder("IN_TRANSIT", "OK7546914590");
    fixture = wrappedPayload("RTO", [{ status: "RTO", datetime: "2026-10-22T09:00:00+05:00" }]);

    const r = await flaship.syncOrderTracking(null, order.id as string);

    expect(r.applied).toBe(true);
    expect((db.orders[0] as Row).status).toBe("RETURNED");
    expect(queueRows().some((q) => q.notification_type === "DELIVERED")).toBe(false);
    expect(inventoryCalls.release).toBe(1); // never-delivered → reservation released
  });

  it("'DELIVERED TO WAREHOUSE' keeps its return-to-origin semantics", async () => {
    const order = seedOrder("IN_TRANSIT", "OK7546914590");
    fixture = wrappedPayload("DELIVERED TO WAREHOUSE IN LAHORE", [
      { status: "DELIVERED TO WAREHOUSE IN LAHORE", datetime: "2026-10-22T09:00:00+05:00" },
    ]);

    await flaship.syncOrderTracking(null, order.id as string);

    expect((db.orders[0] as Row).status).toBe("RETURNED"); // never DELIVERED
    expect(queueRows().some((q) => q.notification_type === "DELIVERED")).toBe(false);
    expect(queueRows().filter((q) => q.notification_type === "SHIPPER_ADVISE")).toHaveLength(1); // group alert (failed: no group configured)
  });

  it("courier CANCELLED never auto-cancels the order (manual-only decision)", async () => {
    const order = seedOrder("BOOKED", "OK7546914590");
    fixture = { success: true, status: "CANCELLED", tracking: [{ status: "CANCELLED", time: "2026-10-22 09:00:00" }] };

    const r = await flaship.syncOrderTracking(null, order.id as string);

    expect(r.applied).toBe(false);
    expect((db.orders[0] as Row).status).toBe("BOOKED");
  });
});

// ------------------------------------- routing / retry behavior intact --------
describe("WhatsApp routing & queue semantics remain intact", () => {
  it("a disabled OUT_FOR_DELIVERY routing row suppresses the customer message", async () => {
    seedOrder("IN_TRANSIT", "OK7546914590");
    db.whatsapp_routing_settings = [{ id: "rt-1", notification_type: "OUT_FOR_DELIVERY", enabled: false }];
    fixture = VERIFIED_4590;

    await flaship.syncOrderTracking(null, (db.orders[0] as Row).id as string);

    expect(queueRows()).toHaveLength(0);
  });

  it("changeOrderStatus (real orders service) still enforces the transition map for manual calls", async () => {
    seedOrder("BOOKED", "OK7546914590");
    const orderId = String((db.orders[0] as Row).id);
    await expect(changeOrderStatus({ userId: "system" }, orderId, "DELIVERED", "skip"))
      .rejects.toThrow(/Cannot change status from BOOKED to DELIVERED/);
  });
});
