/// <reference types="bun-types" />
/**
 * Flaship POST /bookings/ booking contract tests (production fix, 2026-10).
 *
 * Production failure timeline (both layers proven):
 *   1. The original build posted a CAMELCASE payload to {base}/bookings/ —
 *      Flaship's DRF validator requires the snake_case keys, so every key was
 *      reported "This field is required." (DRF only says "required" when the
 *      key is ABSENT from the parsed body — empty values would say
 *      "may not be blank" instead).
 *   2. The 24e0bd4 hotfix built the correct snake_case payload but moved the
 *      endpoint to /orders and canonicalized the stored "/bookings/" to
 *      "/orders". The OFFICIAL Flaship WooCommerce plugin (vendor's own client)
 *      proves booking is created at POST {base}/bookings/ — /orders is
 *      tracking-only — and that the payload lowercases courier_code/
 *      service_type, uses the key `pieces`, and sends "" for
 *      consignee_phone_secondary.
 *
 * Coverage:
 *   A. buildFlashipOrderPayload — every required field populated from REAL
 *      order data (no hardcoded values), plugin-identical wire transformations
 *      (lowercase courier_code/service_type, `pieces`, "" phone secondary),
 *      phone normalization, optional keys, prepaid cod_amount 0.
 *   B. findMissingBookingFields — completeness gate mirrors Flaship's
 *      validator exactly (whitespace/NaN/undefined count as missing).
 *   C. bookOrderWithFlaship (service, mocked transport + DB):
 *      - POST goes to {base}/bookings/ (the official endpoint)
 *      - a stored bad "/orders" endpoint (24e0bd4 default) is healed
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

describe("buildFlashipOrderPayload — POST /bookings/ snake_case contract", () => {
  it("populates EVERY required Flaship field from real order data", () => {
    const payload = buildFlashipOrderPayload(FULL_INPUT);
    // every field Flaship rejected as missing must now be present and non-empty
    for (const key of FLASHIP_ORDER_REQUIRED_FIELDS) {
      const v = payload[key];
      expect(v !== undefined && v !== null && String(v).trim() !== "").toBe(true);
    }
    expect(payload.pickup_id).toBe("PK-9012");
    expect(payload.courier_code).toBe("leopard"); // plugin lowercases courier codes
    expect(payload.service_type).toBe("overnight");
    expect(payload.product_name).toBe("Massage Chair (x1) -- Serum (x3)");
    expect(payload.net_weight).toBe(0.5);
    expect(payload.cod_amount).toBe(1500);
    expect(payload.consignee_name).toBe("Ahmed Raza");
    expect(payload.consignee_phone_primary).toBe("03001234567"); // +92 → 0
    expect(payload.consignee_phone_secondary).toBe(""); // plugin sends '' explicitly
    expect(payload.consignee_address).toBe("12-B, Gulberg III, Lahore");
    expect(payload.consignee_city).toBe("Lahore");
  });

  it("mirrors the plugin's wire transformations: lowercase codes, verbatim pickup id", () => {
    const payload = buildFlashipOrderPayload({
      ...FULL_INPUT,
      pickupId: "12345", // numeric-looking id must stay a STRING (DRF coerces it, like the plugin's absint output)
      courierCode: "MNP",
      serviceType: "Overnight", // UI casing must not leak to the wire
    });
    expect(payload.pickup_id).toBe("12345");
    expect(payload.courier_code).toBe("mnp");
    expect(payload.service_type).toBe("overnight");
  });

  it("sends the plugin's optional keys when available and applies safe defaults otherwise", () => {
    const full = buildFlashipOrderPayload(FULL_INPUT);
    expect(full.pieces).toBe(4); // plugin key name — NOT product_pieces
    expect("product_pieces" in full).toBe(false);
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
    expect(minimal.consignee_phone_secondary).toBe("");
    expect("special_instruction" in minimal).toBe(false);
    expect("external_ref_no" in minimal).toBe(false);
    expect("pieces" in minimal).toBe(false);
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
    // stored endpoints exactly as production has them (seed value) — the
    // official "/bookings/" must pass through VERBATIM (never rewritten)
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

describe("bookOrderWithFlaship — POST /bookings/ transport contract", () => {
  it("POSTs the plugin-identical snake payload to {base}/bookings/ with every required field", async () => {
    seedHappyPath();
    const result = await bookOrderWithFlaship({ userId: "u-admin", role: "super_admin" } as never, "o1");

    expect(fetchCalls).toHaveLength(1);
    const { url, init } = fetchCalls[0];
    // endpoint: the OFFICIAL create-booking endpoint per the Flaship WooCommerce
    // plugin — the stored "/bookings/" (seed value, as in production) passes through
    expect(url).toBe("https://partners.flaship.pk/api/integration/bookings/");
    expect(init.method).toBe("POST");

    const body = JSON.parse(String(init.body));
    for (const key of FLASHIP_ORDER_REQUIRED_FIELDS) {
      expect(body[key] !== undefined && body[key] !== null && String(body[key]).trim() !== "").toBe(true);
    }
    // values from the REAL order data, with the plugin's wire transformations
    expect(body.pickup_id).toBe("PK-9012");
    expect(body.courier_code).toBe("leopard"); // lowercased per plugin strtolower
    expect(body.service_type).toBe("overnight");
    expect(body.product_name).toBe("Massage Chair (x1) -- Serum (x3)");
    expect(body.net_weight).toBe(0.5);
    expect(body.pieces).toBe(4); // 1 chair + 3 serums
    expect(body.cod_amount).toBe(1500);
    expect(body.consignee_name).toBe("Ahmed Raza");
    expect(body.consignee_phone_primary).toBe("03001234567");
    expect(body.consignee_phone_secondary).toBe("");
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

  it("heals a stored bad '/orders' endpoint (24e0bd4 regression) back to /bookings/", async () => {
    seedHappyPath();
    // simulate an environment that saved the bad 24e0bd4 default
    const settingsRow = tables.settings![0] as Row;
    settingsRow.value = {
      ...(settingsRow.value as Row),
      endpoints: { bookings: "/orders" },
    };
    await bookOrderWithFlaship({ userId: "u-admin", role: "super_admin" } as never, "o1");

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("https://partners.flaship.pk/api/integration/bookings/");
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

  it("sends the company-list pickuplocation reference for the mapped pair (merchant_pickup_couriers.external_ref regression)", async () => {
    seedHappyPath();
    // Production failure being fixed: Flaship resolves a booking's pickup_id
    // through merchant_pickup_couriers — the COMPANY-LIST pickuplocation ids,
    // not the standalone address-list ids. After a catalog re-sync with the
    // fixed extractor, the mapped pair's stored id IS the company-list
    // reference, and booking must send exactly that value.
    tables.flaship_pickup_couriers = [{ pickup_id: "PK-COMPANY-77", courier_id: "Leopard" }];
    const result = await bookOrderWithFlaship(
      { userId: "u-admin", role: "super_admin" } as never,
      "o1",
      { courier: "Leopard", pickup: "PK-COMPANY-77" }
    );

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("https://partners.flaship.pk/api/integration/bookings/");
    const body = JSON.parse(String(fetchCalls[0].init.body));
    expect(body.pickup_id).toBe("PK-COMPANY-77"); // the reference Flaship resolves
    expect(body.courier_code).toBe("leopard");
    expect(result.trackingNumber).toBe("FLP123456789"); // booking succeeds → CN returned
  });

  it("blocks an unmapped pickup/courier pair BEFORE any request when mapping data exists (missing merchant_pickup_couriers row regression)", async () => {
    seedHappyPath();
    // Exact production failure mode: Flaship replied
    // 400 {"pickup_id":"Pickup is not synced to this courier (missing merchant_pickup_couriers.external_ref)."}
    // because the selected pair has no merchant_pickup_couriers row. With
    // mapping data synced, the server-side pair guard now rejects that same
    // pair without calling Flaship — no useless POST, no side effects.
    tables.flaship_pickup_couriers = [{ pickup_id: "PK-9012", courier_id: "Leopard" }];
    let error: unknown = null;
    try {
      await bookOrderWithFlaship(
        { userId: "u-admin", role: "super_admin" } as never,
        "o1",
        { courier: "Leopard", pickup: "PK-UNMAPPED" }
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(FlashipError);
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain("not enabled for courier");
    expect(message).toContain("Re-sync the Flaship catalog");
    expect(fetchCalls).toHaveLength(0); // Flaship never sees the invalid pair
    expect(updateCalls).toHaveLength(0); // no booking-state writes
  });
});
