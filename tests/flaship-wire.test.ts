/**
 * Flaship wire-format contract tests — pure functions, no DB, no network, no secrets.
 *
 * Locks the official Flaship Integration API contract (flaship.pk help →
 * "Create booking via API") so a regression back to the old snake_case payload
 * or the old response keys fails loudly:
 *   Required request fields (camelCase):
 *     consigneeName, consigneePhone1, consigneeAddress, destinationCity,
 *     codAmount, productName, productWeight, productPieces,
 *     courierCompany, courierOption, pickuplocation
 *   Success response: { success: true, orderNo: 12345, trackingId: "FLP123456789" }
 */
/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import {
  buildFlashipBookingPayload,
  extractBookingIdentifiers,
  normalizePkPhone,
  unwrap,
  type BookingDefaults,
} from "../src/lib/flaship/wire";

const order = {
  order_number: "RC-1001",
  cod_amount: 1500,
  delivery_address: "House 12, Model Town",
  city: "Lahore",
  notes: "Ring the bell",
};
const cfg: BookingDefaults = { default_weight: 0.5 };
const customer = { name: "Ali Raza", phone: "+923001234567" };

const OFFICIAL_FIELDS = [
  "consigneeName",
  "consigneePhone1",
  "consigneeAddress",
  "destinationCity",
  "codAmount",
  "productName",
  "productWeight",
  "productPieces",
  "courierCompany",
  "courierOption",
  "pickuplocation",
] as const;

const LEGACY_FIELDS = [
  "consignee_name",
  "consignee_phone_primary",
  "consignee_phone_secondary",
  "consignee_address",
  "consignee_city",
  "cod_amount",
  "product_name",
  "net_weight",
  "pieces",
  "courier_code",
  "service_type",
  "pickup_id",
] as const;

describe("buildFlashipBookingPayload", () => {
  test("emits every official camelCase field and no legacy snake_case field", () => {
    const p = buildFlashipBookingPayload({
      order,
      customer,
      items: [{ product_name: "Wheelchair", quantity: 2 }],
      cfg,
    });
    for (const k of OFFICIAL_FIELDS) expect(k in p).toBe(true);
    for (const k of LEGACY_FIELDS) expect(k in p).toBe(false);
  });

  test("maps order/customer/item values onto the official fields", () => {
    const p = buildFlashipBookingPayload({
      order,
      customer,
      items: [{ product_name: "Wheelchair", quantity: 2 }],
      cfg,
    });
    expect(p.consigneeName).toBe("Ali Raza");
    expect(p.consigneePhone1).toBe("03001234567");
    expect(p.consigneeAddress).toBe("House 12, Model Town");
    expect(p.destinationCity).toBe("Lahore");
    expect(p.codAmount).toBe(1500);
    expect(p.productName).toBe("Wheelchair (x2)");
    expect(p.productWeight).toBe(0.5);
    expect(p.productPieces).toBe(2);
    expect(p.externalRefNo).toBe("RC-1001");
    expect(p.specialInstruction).toBe("Ring the bell");
    expect(p.courierOption).toBe("overnight");
  });

  test("courierCompany keeps catalog casing verbatim (no lowercasing)", () => {
    expect(buildFlashipBookingPayload({ order, cfg, opts: { courier: "Leopards" } }).courierCompany).toBe("Leopards");
    expect(buildFlashipBookingPayload({ order, cfg, opts: { courier: "MNP" } }).courierCompany).toBe("MNP");
    expect(buildFlashipBookingPayload({ order, cfg: { ...cfg, default_courier: "TCS" } }).courierCompany).toBe("TCS");
  });

  test("pickuplocation passes catalog values through verbatim (pure-integer strings restore number type)", () => {
    expect(buildFlashipBookingPayload({ order, cfg, opts: { pickup: "12" } }).pickuplocation).toBe(12);
    expect(buildFlashipBookingPayload({ order, cfg, opts: { pickup: "PCK-9" } }).pickuplocation).toBe("PCK-9");
    expect(buildFlashipBookingPayload({ order, cfg: { ...cfg, default_pickup: "7" } }).pickuplocation).toBe(7);
    expect(buildFlashipBookingPayload({ order, cfg }).pickuplocation).toBe("");
  });

  test("courierOption honours overrides and valid official values", () => {
    expect(buildFlashipBookingPayload({ order, cfg, opts: { serviceType: "Overland" } }).courierOption).toBe("overland");
    expect(buildFlashipBookingPayload({ order, cfg: { ...cfg, default_service_type: "detain" } }).courierOption).toBe("detain");
  });

  test("empty items fall back to a generic product name and one piece", () => {
    const p = buildFlashipBookingPayload({ order, cfg });
    expect(p.productName).toBe("Products");
    expect(p.productPieces).toBe(1);
  });
});

describe("extractBookingIdentifiers", () => {
  test("parses the official success response (orderNo / trackingId)", () => {
    const r = extractBookingIdentifiers({ success: true, orderNo: 12345, trackingId: "FLP123456789" });
    expect(r.bookingId).toBe("12345");
    expect(r.cn).toBe("FLP123456789");
  });

  test("unwraps { data: ... } style wrappers before parsing", () => {
    const r = extractBookingIdentifiers({ data: { success: true, orderNo: 42, trackingId: "FLP1" } });
    expect(r.bookingId).toBe("42");
    expect(r.cn).toBe("FLP1");
  });

  test("keeps legacy/simulator fallback keys working", () => {
    const r = extractBookingIdentifiers({ success: true, id: "FLB9", tracking_number: "CN123", courier_code: "postex" });
    expect(r.bookingId).toBe("FLB9");
    expect(r.cn).toBe("CN123");
    expect(r.courierCode).toBe("postex");
  });

  test("reads courierCompany from the official response shape", () => {
    const r = extractBookingIdentifiers({ success: true, orderNo: 1, trackingId: "FLP2", courierCompany: "Leopards" });
    expect(r.courierCode).toBe("Leopards");
  });

  test("missing tracking returns empty cn (caller raises the CN error)", () => {
    expect(extractBookingIdentifiers({ success: false }).cn).toBe("");
  });
});

describe("shared helpers", () => {
  test("normalizePkPhone keeps the +92/92 → 0 normalization", () => {
    expect(normalizePkPhone("+923001234567")).toBe("03001234567");
    expect(normalizePkPhone("923001234567")).toBe("03001234567");
    expect(normalizePkPhone("03001234567")).toBe("03001234567");
  });

  test("unwrap digs through common response wrappers", () => {
    expect(unwrap({ data: { orderNo: 1 } }).orderNo).toBe(1);
    expect(unwrap({ result: { trackingId: "x" } }).trackingId).toBe("x");
    expect(unwrap({ orderNo: 2 }).orderNo).toBe(2);
  });
});
