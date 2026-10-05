/// <reference types="bun-types" />
/**
 * Flaship protocol tests — pure functions only (no DB, no network, no secrets).
 *
 * Coverage map (per Task 38 requirements):
 *   1. courier/pickup mapping          → extractCatalog (companies[] linkage)
 *   2. valid mapped pair               → isPairMapped / filterPickupsForCourier
 *   3. invalid pair prevention         → isPairMapped === false / filtered out
 *   4. official booking payload        → buildBookingPayload (camelCase, verbatim values)
 *   5. Flaship field-level errors      → extractApiErrorMessage (DRF-style bodies)
 *   + booking response parsing (orderNo/trackingId) + phone normalization
 */
import { describe, it, expect } from "bun:test";
import {
  buildBookingPayload,
  parseBookingResponse,
  extractCatalog,
  isPairMapped,
  filterPickupsForCourier,
  extractApiErrorMessage,
  normalizePkPhone,
  type PickupCourierLink,
} from "../src/lib/flaship/protocol";

// ---------------------------------------------------------------
// 4. Official booking payload
// ---------------------------------------------------------------
describe("buildBookingPayload — official camelCase contract", () => {
  it("sends exactly the 11 official camelCase fields with values VERBATIM", () => {
    const payload = buildBookingPayload({
      courierCompany: "Leopard",
      pickuplocation: "PK-9012",
      courierOption: "overnight",
      consigneeName: " Test Customer ",
      consigneePhone1: "+923001234567",
      consigneeAddress: "12-B, Gulberg III, Lahore",
      destinationCity: "Lahore",
      codAmount: 1500,
      productName: "Catalog (x2)",
      productWeight: 0.5,
      productPieces: 2,
    });
    expect(Object.keys(payload).sort()).toEqual(
      [
        "codAmount",
        "consigneeAddress",
        "consigneeName",
        "consigneePhone1",
        "courierCompany",
        "courierOption",
        "destinationCity",
        "pickuplocation",
        "productPieces",
        "productName",
        "productWeight",
      ].sort()
    );
    // verbatim courier — NO lowercasing (Flaship is case-sensitive)
    expect(payload.courierCompany).toBe("Leopard");
    // verbatim pickup — NO parseInt / numeric coercion
    expect(payload.pickuplocation).toBe("PK-9012");
    expect(payload.consigneeName).toBe("Test Customer");
    expect(payload.consigneePhone1).toBe("03001234567");
    expect(payload.destinationCity).toBe("Lahore");
    expect(payload.codAmount).toBe(1500);
    expect(payload.courierOption).toBe("overnight");
    // no snake_case leftovers from the old wire format
    expect("courier_code" in payload).toBe(false);
    expect("pickup_id" in payload).toBe(false);
    expect("consignee_phone_primary" in payload).toBe(false);
  });

  it("never coerces numeric-looking pickup ids and never mangles mixed-case couriers", () => {
    const payload = buildBookingPayload({
      courierCompany: "MNP",
      pickuplocation: "12345",
      courierOption: "overland",
      consigneeName: "A",
      consigneePhone1: "923009998887",
      consigneeAddress: "x",
      destinationCity: "Karachi",
      codAmount: 0,
      productName: "P",
      productWeight: 0.5,
      productPieces: 1,
    });
    expect(payload.pickuplocation).toBe("12345");
    expect(payload.courierCompany).toBe("MNP");
  });

  it("applies safe defaults (name, product, pieces floor, weight) and normalizes PK phones", () => {
    const payload = buildBookingPayload({
      courierCompany: "TCS",
      pickuplocation: "PK1",
      courierOption: "detain",
      consigneeName: "",
      consigneePhone1: "+92-300 111 2222",
      consigneeAddress: "",
      destinationCity: "",
      codAmount: NaN,
      productName: "",
      productWeight: NaN,
      productPieces: 0,
    });
    expect(payload.consigneeName).toBe("Customer");
    expect(payload.productName).toBe("Products");
    expect(payload.productPieces).toBe(1);
    expect(payload.productWeight).toBe(0.5);
    expect(payload.codAmount).toBe(0);
    expect(payload.consigneePhone1).toBe("03001112222");
  });
});

describe("normalizePkPhone", () => {
  it("maps +92 / 92 prefixes to a leading 0 and keeps local formats", () => {
    expect(normalizePkPhone("+923001234567")).toBe("03001234567");
    expect(normalizePkPhone("923001234567")).toBe("03001234567");
    expect(normalizePkPhone("03001234567")).toBe("03001234567");
    expect(normalizePkPhone("0300-1234567")).toBe("03001234567");
  });
});

// ---------------------------------------------------------------
// Booking response parsing (official orderNo/trackingId)
// ---------------------------------------------------------------
describe("parseBookingResponse", () => {
  it("parses the OFFICIAL success shape {success, orderNo, trackingId}", () => {
    const parsed = parseBookingResponse({ success: true, orderNo: 12345, trackingId: "FLP123456789" });
    expect(parsed.bookingId).toBe("12345");
    expect(parsed.trackingNumber).toBe("FLP123456789");
    expect(parsed.courierName).toBe("Flaship");
  });

  it("keeps legacy response shapes working as fallbacks", () => {
    const legacy = parseBookingResponse({ success: true, id: "FLB1", tracking_number: "CN999", courier_code: "Leopard" });
    expect(legacy.bookingId).toBe("FLB1");
    expect(legacy.trackingNumber).toBe("CN999");
    expect(legacy.courierName).toBe("LEOPARD");
  });

  it("unwraps {data: …} envelopes and uses the courier fallback", () => {
    const wrapped = parseBookingResponse(
      { data: { success: true, orderNo: 7, trackingId: "FLP7" } },
      "Leopard"
    );
    expect(wrapped.trackingNumber).toBe("FLP7");
    expect(wrapped.courierName).toBe("Leopard"); // body had no courier field → explicit fallback used
  });

  it("throws a clear error when no tracking number (CN) is returned", () => {
    expect(() => parseBookingResponse({ success: true, orderNo: 5 })).toThrow(
      "Flaship did not return a tracking number (CN)."
    );
  });
});

// ---------------------------------------------------------------
// 1. Courier/pickup mapping extraction
// ---------------------------------------------------------------
describe("extractCatalog — pickup↔courier mapping", () => {
  it("extracts the mapping from OFFICIAL companies[] entries and preserves original casing", () => {
    const raw = {
      companies: [
        { code: "Leopard", display_name: "Leopard Express", pickups: [{ id: "PK1" }, { id: "PK2" }] },
        { code: "TCS", name: "TCS", pickups: ["PK3"] },
      ],
      pickupAddress: [
        { id: "PK1", name: "Main Warehouse", address: "Karachi", city: "Karachi" },
        { id: "PK2", name: "Lahore Hub", city: "Lahore" },
        { id: "PK3", name: "Islamabad Point", city: "Islamabad" },
      ],
      operational_cities: { Leopard: ["Karachi", "Lahore"], TCS: ["Islamabad"] },
    };
    const cat = extractCatalog(raw);
    expect(cat.couriers.map((c) => c.courier_id)).toEqual(["Leopard", "TCS"]); // casing preserved
    expect(cat.pickups.map((p) => p.pickup_id)).toEqual(["PK1", "PK2", "PK3"]);
    expect(cat.links).toEqual([
      { pickup_id: "PK1", courier_id: "Leopard" },
      { pickup_id: "PK2", courier_id: "Leopard" },
      { pickup_id: "PK3", courier_id: "TCS" },
    ]);
    expect(cat.cities.length).toBe(3);
  });

  it("extracts mapping declared on the pickup side (courier/companies fields) and dedupes", () => {
    const raw = {
      companies: [{ code: "MNP", name: "M&P" }],
      pickups: [
        { id: "PK-A", name: "A", courier: "mnp" }, // lowercase ref → normalized to official code
        { id: "PK-B", name: "B", couriers: ["MNP", "MNP"] }, // duplicates removed
      ],
    };
    const cat = extractCatalog(raw);
    expect(cat.links).toEqual([
      { pickup_id: "PK-A", courier_id: "MNP" },
      { pickup_id: "PK-B", courier_id: "MNP" },
    ]);
  });

  it("still reads legacy catalog shapes (couriers/pickups keys) without links", () => {
    const raw = {
      couriers: [{ code: "TCS", name: "TCS" }],
      pickups: [{ id: "PK9", name: "Warehouse" }],
      cities: ["Karachi"],
    };
    const cat = extractCatalog(raw);
    expect(cat.couriers[0]?.courier_id).toBe("TCS");
    expect(cat.pickups[0]?.pickup_id).toBe("PK9");
    expect(cat.links).toEqual([]);
  });
});

// ---------------------------------------------------------------
// 2 + 3. Valid / invalid pair handling
// ---------------------------------------------------------------
const LINKS: PickupCourierLink[] = [
  { pickup_id: "PK1", courier_id: "Leopard" },
  { pickup_id: "PK2", courier_id: "Leopard" },
  { pickup_id: "PK3", courier_id: "TCS" },
];
const PICKUPS = [
  { pickup_id: "PK1", name: "Main Warehouse" },
  { pickup_id: "PK2", name: "Lahore Hub" },
  { pickup_id: "PK3", name: "Islamabad Point" },
];

describe("isPairMapped — valid pair accepted, invalid pair prevented", () => {
  it("accepts a valid mapped pair", () => {
    expect(isPairMapped("Leopard", "PK1", LINKS)).toBe(true);
    expect(isPairMapped("TCS", "PK3", LINKS)).toBe(true);
  });

  it("rejects an unmapped (invalid) pair with the exact production failure mode", () => {
    // this is the pair that produced:
    // {"pickup_id":"Pickup is not synced to this courier …"}
    expect(isPairMapped("Leopard", "PK3", LINKS)).toBe(false);
    expect(isPairMapped("TCS", "PK1", LINKS)).toBe(false);
  });

  it("returns null (unknown) when the mapping has no data for the courier", () => {
    expect(isPairMapped("Trax", "PK1", LINKS)).toBeNull();
    expect(isPairMapped("Leopard", "PK1", [])).toBeNull();
  });
});

describe("filterPickupsForCourier — UI-level invalid pair prevention", () => {
  it("offers only pickups mapped to the selected courier", () => {
    const leopard = filterPickupsForCourier(PICKUPS, LINKS, "Leopard");
    expect(leopard.map((p) => p.pickup_id)).toEqual(["PK1", "PK2"]);
    const tcs = filterPickupsForCourier(PICKUPS, LINKS, "TCS");
    expect(tcs.map((p) => p.pickup_id)).toEqual(["PK3"]);
  });

  it("blocks booking with a courier that has no mapped pickups", () => {
    expect(filterPickupsForCourier(PICKUPS, LINKS, "PostEx")).toEqual([]);
  });

  it("degrades gracefully when no mapping data exists (legacy behavior)", () => {
    expect(filterPickupsForCourier(PICKUPS, [], "Leopard")).toEqual(PICKUPS);
  });
});

// ---------------------------------------------------------------
// 5. Flaship field-level error messages
// ---------------------------------------------------------------
describe("extractApiErrorMessage — field-level (DRF) error bodies", () => {
  it("surfaces the exact production pickup-mapping error", () => {
    const body = { pickup_id: "Pickup is not synced to this courier (missing merchant_pickup_couriers.external_ref)." };
    const msg = extractApiErrorMessage(body, 400);
    expect(msg).toBe("pickup_id: Pickup is not synced to this courier (missing merchant_pickup_couriers.external_ref).");
  });

  it("joins multiple field errors and array-valued DRF errors", () => {
    expect(extractApiErrorMessage({ consigneeName: ["This field is required."], codAmount: ["A valid number is required."] }, 400)).toBe(
      "consigneeName: This field is required. | codAmount: A valid number is required."
    );
    expect(extractApiErrorMessage({ non_field_errors: ["Quota exceeded"] }, 400)).toBe("non_field_errors: Quota exceeded");
  });

  it("keeps message/detail/error precedence and the generic fallback", () => {
    expect(extractApiErrorMessage({ detail: "Invalid API key." }, 401)).toBe("Invalid API key.");
    expect(extractApiErrorMessage({ message: "Oops", pickup_id: "other" }, 400)).toBe("Oops");
    expect(extractApiErrorMessage("Rate limited", 429)).toBe("Rate limited");
    expect(extractApiErrorMessage({ success: false }, 400)).toBe("Flaship API error (HTTP 400)");
    expect(extractApiErrorMessage(null, 500)).toBe("Flaship API error (HTTP 500)");
  });

  it("parses JSON-string bodies", () => {
    const raw = JSON.stringify({ pickup_id: "Pickup is not synced to this courier." });
    expect(extractApiErrorMessage(raw, 400)).toBe("pickup_id: Pickup is not synced to this courier.");
  });
});
