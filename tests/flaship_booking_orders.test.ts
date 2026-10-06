/// <reference types="bun-types" />
/**
 * Flaship POST /orders booking contract tests (production fix, 2026-10).
 *
 * Production failure: Flaship reachable + auth OK, but the booking POST was
 * rejected because the required snake_case fields were absent:
 *   pickup_id, courier_code, service_type, product_name, net_weight,
 *   cod_amount, consignee_name, consignee_phone_primary, consignee_address,
 *   consignee_city
 *
 * Coverage:
 *   A. buildFlashipOrderPayload — every required field populated from REAL
 *      order data (no hardcoded values), verbatim catalog fidelity, phone
 *      normalization, optional keys, prepaid cod_amount 0.
 *   B. findMissingBookingFields — completeness gate mirrors Flaship's
 *      validator exactly (whitespace/NaN/undefined count as missing).
 *   C. bookOrderWithFlaship (service, mocked transport + DB):
 *      - POST goes to {base}/orders (NOT the legacy /bookings/)
 *      - legacy stored endpoints.bookings="/bookings/" is canonicalized
 *      - request body carries every required field from the fake order
 *      - missing order data → useful FlashipError BEFORE any fetch or
 *        booking-state write (zero side effects)
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import {
  buildFlashipOrderPayload,
  findMissingBookingFields,
  FLASHIP_ORDER_REQUIRED_FIELDS,
} from "../src/lib/flaship/protocol";

// ================================================================
// A + B. Pure payload / validator contract
// ================================================================

const FULL_INPUT = {
  pickupId: "PK-9012",
  courierCode: "Leopard",
  serviceType: "overnight",
  productName: "Massage Chair (x1) -- Serum (x3)",
  netWeight: 0.5,
  codAmount: 1500,
  consigneeName: "Ahmed Raza",
  consigneePhonePrimary: "+923001234567",
  consigneeAddress: "12-B, Gulberg III, Lahore",
  consigneeCity: "Lahore",
  productPieces: 4,
  specialInstruction: "Ring the bell",
  externalRefNo: "RC-1001",
};

describe("buildFlashipOrderPayload — POST /orders snake_case contract", () => {
  it("populates EVERY required Flaship field from real order data", () => {
    const payload = buildFlashipOrderPayload(FULL_INPUT);
    // every field Flaship rejected as missing must now be present and non-empty
    for (const key of FLASHIP_ORDER_REQUIRED_FIELDS) {
      const v = payload[key];
      expect(v !== undefined && v !== null && String(v).trim() !== "").toBe(true);
    }
    expect(payload.pickup_id).toBe("PK-9012");
    expect(payload.courier_code).toBe("Leopard");
    expect(payload.service_type).toBe("overnight");
    expect(payload.product_name).toBe("Massage Chair (x1) -- Serum (x3)");
    expect(payload.net_weight).toBe(0.5);
    expect(payload.cod_amount).toBe(1500);
    expect(payload.consignee_name).toBe("Ahmed Raza");
    expect(payload.consignee_phone_primary).toBe("03001234567"); // +92 → 0
    expect(payload.consignee_address).toBe("12-B, Gulberg III, Lahore");
    expect(payload.consignee_city).toBe("Lahore");
  });

  it("keeps catalog fidelity: no lowercasing, no parseInt on ids", () => {
    const payload = buildFlashipOrderPayload({
      ...FULL_INPUT,
      pickupId: "12345", // numeric-looking id must stay a STRING
      courierCode: "MNP",
    });
    expect(payload.pickup_id).toBe("12345");
    expect(payload.courier_code).toBe("MNP");
  });

  it("sends optional keys when available and applies safe defaults otherwise", () => {
    const full = buildFlashipOrderPayload(FULL_INPUT);
    expect(full.product_pieces).toBe(4);
    expect(full.special_instruction).toBe("Ring the bell");
    expect(full.external_ref_no).toBe("RC-1001");

    const minimal = buildFlashipOrderPayload({
      pickupId: "PK1",
      courierCode: "TCS",
      serviceType: "",
      productName: "Products",
      netWeight: NaN,
      codAmount: 0, // prepaid order — valid
      consigneeName: "A",
      consigneePhonePrimary: "03001112222",
      consigneeAddress: "x",
      consigneeCity: "Karachi",
    });
    expect(minimal.service_type).toBe("overnight"); // default
    expect(minimal.net_weight).toBe(0.5); // default
    expect(minimal.cod_amount).toBe(0); // preserved
    expect("special_instruction" in minimal).toBe(false);
    expect("external_ref_no" in minimal).toBe(false);
  });
});

describe("findMissingBookingFields — server-side completeness gate", () => {
  it("returns [] for a complete payload (cod_amount 0 = prepaid is valid)", () => {
    const payload = buildFlashipOrderPayload({ ...FULL_INPUT, codAmount: 0 });
    expect(findMissingBookingFields(payload)).toEqual([]);
  });

  it("lists every missing field with the exact names Flaship validates", () => {
    const payload = buildFlashipOrderPayload({
      ...FULL_INPUT,
      consigneeName: "",
      consigneePhonePrimary: "",
      consigneeAddress: "   ",
      consigneeCity: undefined as unknown as string,
    });
    expect(findMissingBookingFields(payload)).toEqual([
      "consignee_name",
      "consignee_phone_primary",
      "consignee_address",
      "consignee_city",
    ]);
  });

  it("treats non-finite numbers as missing (defensive, direct payload)", () => {
    // The builder's safe defaults (|| 0.5 / || 0) make non-finite inputs
    // unreachable via the service path; the gate still defends against them.
    const payload = { ...buildFlashipOrderPayload(FULL_INPUT), net_weight: NaN, cod_amount: Infinity };
    expect(findMissingBookingFields(payload)).toEqual(["net_weight", "cod_amount"]);
  });
});

// ================================================================
// C. Service-level booking flow (mocked transport + DB, no secrets)
// ================================================================

mock.module("server-only", () => ({}));

type Row = Record<string, unknown>;
let tables: Record<string, Row[]> = {};
const updateCalls: { table: string; id: string; patch: Row }[] = [];
const insertCalls: { table: string; row: Row }[] = [];
let fetchCalls: { url: string; init: RequestInit }[] = [];

function seedHappyPath() {
  tables = {
    orders: [
      {
        id: "o1",
        order_number: "RC-1001",
        customer_id: "c1",
        cod_amount: 1500,
        delivery_address: "12-B, Gulberg III, Lahore",
        city: "Lahore",
        notes: "Ring the bell",
        status: "PENDING",
        approval_status: "APPROVED",
        booking_status: null,
      },
    ],
    customers: [{ id: "c1", name: "Ahmed Raza", phone: "+923001234567" }],
    order_items: [
      { order_id: "o1", product_name: "Massage Chair", quantity: 1 },
      { order_id: "o1", product_name: "Serum", quantity: 3 },
    ],
    // live-mode pair guard data: (Leopard, PK-9012) is mapped
    flaship_pickup_couriers: [{ pickup_id: "PK-9012", courier_id: "Leopard" }],
    // legacy stored endpoints — must be canonicalized to /orders
    settings: [
      {
        key: "flaship",
        value: {
          mode: "live",
          default_courier: "Leopard",
          default_pickup: "PK-9012",
          default_service_type: "overnight",
          default_weight: 0.5,
          api_key_enc: "enc-test",
          endpoints: { bookings: "/bookings/" },
        },
      },
    ],
  };
}

function seedMissingData() {
  seedHappyPath();
  tables.customers = [{ id: "c1", name: "Ahmed Raza", phone: "" }];
  tables.orders = [{ ...(tables.orders[0] as Row), city: "" }];
}

mock.module("@/lib/store", () => ({
  IS_DEMO_MODE: false,
  store: {
    get: async (table: string, id: string) => (tables[table] ?? []).find((r) => r.id === id) ?? null,
    list: async (table: string, opts?: { filters?: Row }) => {
      let rows = tables[table] ?? [];
      const f = opts?.filters;
      if (f) rows = rows.filter((r) => Object.entries(f).every(([k, v]) => r[k] === v));
      return { rows, total: rows.length };
    },
    first: async (table: string, opts?: { filters?: Row }) =>
      (tables[table] ?? []).find((r) => !opts?.filters || Object.entries(opts.filters).every(([k, v]) => r[k] === v)) ?? null,
    update: async (table: string, id: string, patch: Row) => {
      updateCalls.push({ table, id, patch });
      return { id, ...patch };
    },
    insert: async (table: string, row: Row) => {
      insertCalls.push({ table, row });
      return row;
    },
    count: async () => 0,
  },
}));

mock.module("@/lib/crypto/secret-box", () => ({
  decryptSecret: async () => "test-key-not-a-real-secret",
}));
mock.module("@/lib/services/audit", () => ({ logAudit: async () => {} }));
mock.module("@/lib/services/notifications", () => ({
  notify: async () => {},
  notifyAdmins: async () => {},
  notifyWorker: async () => {},
}));
mock.module("@/lib/services/orders", () => ({ changeOrderStatus: async () => {} }));
mock.module("@/lib/services/whatsapp", () => ({ enqueueWhatsAppOrderEvent: async () => {} }));

// Import the REAL service under a distinct module key: other suite files
// (production_audit / flaship_routes) mock "@/lib/flaship/service" globally
// with fakes; the query string gives this file a fresh, unmocked evaluation
// while its own dependencies (store/crypto/audit/…) still hit OUR mocks above.
const REAL_SERVICE = "../src/lib/flaship/service?real";
const { bookOrderWithFlaship, FlashipError } = await import(REAL_SERVICE);

beforeEach(() => {
  updateCalls.length = 0;
  insertCalls.length = 0;
  fetchCalls = [];
  // capture (never a real network call)
  globalThis.fetch = (async (url: unknown, init: RequestInit = {} as RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    return new Response(JSON.stringify({ success: true, orderNo: 123, trackingId: "FLP123456789" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }) as unknown as Response;
  }) as typeof fetch;
});

describe("bookOrderWithFlaship — POST /orders transport contract", () => {
  it("POSTs to {base}/orders (legacy /bookings/ canonicalized) with every required field", async () => {
    seedHappyPath();
    const result = await bookOrderWithFlaship({ userId: "u-admin", role: "super_admin" } as never, "o1");

    expect(fetchCalls).toHaveLength(1);
    const { url, init } = fetchCalls[0];
    // endpoint: base + /orders — the legacy stored "/bookings/" must NOT win
    expect(url).toBe("https://partners.flaship.pk/api/integration/orders");
    expect(init.method).toBe("POST");

    const body = JSON.parse(String(init.body));
    for (const key of FLASHIP_ORDER_REQUIRED_FIELDS) {
      expect(body[key] !== undefined && body[key] !== null && String(body[key]).trim() !== "").toBe(true);
    }
    // values from the REAL order data, verbatim where required
    expect(body.pickup_id).toBe("PK-9012");
    expect(body.courier_code).toBe("Leopard");
    expect(body.service_type).toBe("overnight");
    expect(body.product_name).toBe("Massage Chair (x1) -- Serum (x3)");
    expect(body.net_weight).toBe(0.5);
    expect(body.cod_amount).toBe(1500);
    expect(body.consignee_name).toBe("Ahmed Raza");
    expect(body.consignee_phone_primary).toBe("03001234567");
    expect(body.consignee_address).toBe("12-B, Gulberg III, Lahore");
    expect(body.consignee_city).toBe("Lahore");
    expect(body.external_ref_no).toBe("RC-1001");

    // parsed official response → order booked (no courier field in body →
    // verbatim selection fallback used as courier name)
    expect(result.bookingId).toBe("123");
    expect(result.trackingNumber).toBe("FLP123456789");
    expect(result.courierName).toBe("Leopard");
    const booked = updateCalls.find((u) => u.table === "orders" && u.patch.booking_status === "booked");
    expect(booked).toBeDefined();
  });

  it("fails BEFORE any request or state change when order data is incomplete", async () => {
    seedMissingData();
    let error: unknown = null;
    try {
      await bookOrderWithFlaship({ userId: "u-admin", role: "super_admin" } as never, "o1");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(FlashipError);
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain("missing required field(s)");
    expect(message).toContain("consignee_phone_primary");
    expect(message).toContain("consignee_city");
    // zero side effects: no HTTP call, no pending/booked writes, no shipment rows
    expect(fetchCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
    expect(insertCalls.filter((i) => i.table === "shipments")).toHaveLength(0);
  });
});
