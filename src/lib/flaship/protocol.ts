/**
 * Flaship Integration API protocol helpers — PURE functions, no I/O.
 *
 * Technical reference (official Flaship /help page, re-verified 2026-10):
 *   POST {base}/bookings/  required fields (camelCase, verbatim values):
 *     consigneeName, consigneePhone1, consigneeAddress, destinationCity,
 *     codAmount, productName, productWeight, productPieces,
 *     courierCompany (e.g. "Leopard", "TCS", "MNP" — case-sensitive),
 *     courierOption (overnight | overland | detain),
 *     pickuplocation — "pickup location ID from company list"
 *   Success response: {"success": true, "orderNo": 12345, "trackingId": "FLP123456789"}
 *   GET {base}/catalog/ returns `pickupAddress`, `companies`, `rateCards` and
 *   operational cities. Each `companies[]` entry carries the pickup locations
 *   enabled for that courier — the booking `pickuplocation` MUST come from that
 *   list, otherwise Flaship rejects the pair:
 *     {"pickup_id":"Pickup is not synced to this courier
 *       (missing merchant_pickup_couriers.external_ref)."}
 *
 * IMPORTANT value-fidelity rules (root causes of past production 400s):
 *   - courierCompany is sent EXACTLY as returned by the catalog (no lowercasing).
 *   - pickuplocation is sent EXACTLY as returned by the catalog (no parseInt /
 *     numeric coercion — IDs are opaque strings).
 *
 * This module is imported by server code AND unit tests; it must stay free of
 * side effects, filesystem, database and "server-only" imports.
 */

// ---------------- Phone normalization ----------------

/** Normalize Pakistani phone formats: +92 / 92 prefixes → leading 0 (per Flaship plugin). */
export function normalizePkPhone(phone: string): string {
  const cleaned = String(phone ?? "").replace(/[^0-9+]/g, "");
  if (cleaned.startsWith("+92")) return `0${cleaned.slice(3)}`;
  if (cleaned.startsWith("92")) return `0${cleaned.slice(2)}`;
  return cleaned;
}

// ---------------- Booking payload (POST /bookings/) ----------------

export interface BookingPayloadInput {
  /** Verbatim catalog courier identity — case-sensitive (e.g. "Leopard"). */
  courierCompany: string;
  /** Verbatim catalog pickup location ID — opaque, never numerically coerced. */
  pickuplocation: string;
  /** overnight | overland | detain */
  courierOption: string;
  consigneeName: string;
  consigneePhone1: string;
  consigneeAddress: string;
  destinationCity: string;
  codAmount: number;
  productName: string;
  productWeight: number;
  productPieces: number;
}

/**
 * Build the official camelCase booking payload. Sends EXACTLY the fields the
 * Integration API documents — 11 required keys, camelCase, values verbatim.
 */
export function buildBookingPayload(input: BookingPayloadInput): Record<string, unknown> {
  return {
    consigneeName: String(input.consigneeName ?? "").trim() || "Customer",
    consigneePhone1: normalizePkPhone(input.consigneePhone1 ?? ""),
    consigneeAddress: String(input.consigneeAddress ?? "").trim(),
    destinationCity: String(input.destinationCity ?? "").trim(),
    codAmount: Number(input.codAmount ?? 0) || 0,
    productName: String(input.productName ?? "").trim() || "Products",
    productWeight: Number(input.productWeight ?? 0.5) || 0.5,
    productPieces: Math.max(1, Number(input.productPieces ?? 1) || 1),
    // Value fidelity: NO toLowerCase(), NO parseInt() — Flaship validates the
    // courier/pickup pair case-sensitively against merchant_pickup_couriers.
    courierCompany: String(input.courierCompany ?? "").trim(),
    courierOption: String(input.courierOption ?? "").trim(),
    pickuplocation: String(input.pickuplocation ?? "").trim(),
  };
}

// ---------------- Booking payload (POST /orders — snake_case contract) ----------------

/**
 * Official /orders create-booking contract. Required keys EXACTLY as Flaship's
 * validator reports them (DRF snake_case):
 *   pickup_id, courier_code, service_type, product_name, net_weight,
 *   cod_amount, consignee_name, consignee_phone_primary, consignee_address,
 *   consignee_city
 * Optional best-effort keys sent when available: product_pieces,
 * special_instruction, external_ref_no.
 *
 * Value-fidelity rules (same as the legacy /bookings/ contract):
 *   - pickup_id / courier_code pass through VERBATIM from the catalog
 *     (no lowercasing, no numeric coercion).
 *   - consignee_phone_primary is normalized (+92/92 → 0).
 */
export interface FlashipOrderPayloadInput {
  /** Verbatim catalog pickup location id. */
  pickupId: string;
  /** Verbatim catalog courier code (case-sensitive, e.g. "Leopard"). */
  courierCode: string;
  /** overnight | overland | detain */
  serviceType: string;
  productName: string;
  /** Weight in kg. */
  netWeight: number;
  codAmount: number;
  consigneeName: string;
  consigneePhonePrimary: string;
  consigneeAddress: string;
  consigneeCity: string;
  productPieces?: number;
  specialInstruction?: string;
  externalRefNo?: string;
}

/** The exact required-field list Flaship enforces on POST /orders. */
export const FLASHIP_ORDER_REQUIRED_FIELDS = [
  "pickup_id",
  "courier_code",
  "service_type",
  "product_name",
  "net_weight",
  "cod_amount",
  "consignee_name",
  "consignee_phone_primary",
  "consignee_address",
  "consignee_city",
] as const;

/**
 * Build the POST /orders body (snake_case). Pure function — values come from
 * the caller (order / customer / items / settings / booking selection).
 */
export function buildFlashipOrderPayload(input: FlashipOrderPayloadInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    // Value fidelity: NO toLowerCase(), NO parseInt() — Flaship validates the
    // courier/pickup pair case-sensitively against merchant_pickup_couriers.
    pickup_id: String(input.pickupId ?? "").trim(),
    courier_code: String(input.courierCode ?? "").trim(),
    service_type: String(input.serviceType ?? "").trim() || "overnight",
    product_name: String(input.productName ?? "").trim() || "Products",
    net_weight: Number(input.netWeight ?? 0.5) || 0.5,
    cod_amount: Number(input.codAmount ?? 0) || 0,
    consignee_name: String(input.consigneeName ?? "").trim(),
    consignee_phone_primary: normalizePkPhone(input.consigneePhonePrimary ?? ""),
    consignee_address: String(input.consigneeAddress ?? "").trim(),
    consignee_city: String(input.consigneeCity ?? "").trim(),
  };
  if (input.productPieces !== undefined) {
    payload.product_pieces = Math.max(1, Number(input.productPieces) || 1);
  }
  const instruction = String(input.specialInstruction ?? "").trim();
  if (instruction) payload.special_instruction = instruction;
  const externalRef = String(input.externalRefNo ?? "").trim();
  if (externalRef) payload.external_ref_no = externalRef;
  return payload;
}

/**
 * Server-side completeness gate: returns every required key Flaship would
 * reject, so the caller can fail BEFORE hitting the API with a useless
 * request. Empty/whitespace strings and non-finite numbers count as missing;
 * cod_amount 0 (prepaid) is valid.
 */
export function findMissingBookingFields(payload: Record<string, unknown>): string[] {
  const missing: string[] = [];
  for (const key of FLASHIP_ORDER_REQUIRED_FIELDS) {
    const v = payload[key];
    if (typeof v === "number") {
      if (!Number.isFinite(v)) missing.push(key);
    } else if (typeof v !== "string" || !v.trim()) {
      missing.push(key);
    }
  }
  return missing;
}

// ---------------- Booking response parsing ----------------

export interface ParsedBooking {
  bookingId: string;
  trackingNumber: string;
  courierName: string;
}

/**
 * Parse the booking response. Official shape:
 *   {"success": true, "orderNo": 12345, "trackingId": "FLP123456789"}
 * Legacy/alternate shapes are tolerated as fallbacks. Throws when no CN.
 */
export function parseBookingResponse(result: unknown, fallbackCourierName?: string): ParsedBooking {
  let body = (result ?? {}) as Record<string, unknown>;
  // unwrap common response envelopes ({data: ...}, {result: ...}, ...)
  for (const key of ["data", "result", "payload", "response"]) {
    const inner = body[key];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      body = inner as Record<string, unknown>;
      break;
    }
  }
  const bookingId = String(
    body.orderNo ?? body.id ?? body.booking_id ?? body.bookingId ?? body.external_ref_no ?? `FLB${Date.now()}`
  );
  const cn = String(body.trackingId ?? body.tracking_number ?? body.trackingNumber ?? body.cn ?? "").trim();
  if (!cn) throw new Error("Flaship did not return a tracking number (CN).");
  const courierRaw = String(body.courierCompany ?? body.courier_company ?? body.courier_code ?? "").trim();
  const courierName = courierRaw
    ? courierRaw.toUpperCase()
    : String(body.courier_name ?? (fallbackCourierName ?? "")).trim() || "Flaship";
  return { bookingId, trackingNumber: cn, courierName };
}

// ---------------- Catalog extraction (GET /catalog/) ----------------

export interface CatalogCourier {
  courier_id: string;
  name: string;
  code: string;
}
export interface CatalogPickup {
  pickup_id: string;
  name: string;
  address: string | null;
  city: string | null;
  contact: string | null;
}
export interface CatalogCity {
  city_id: string;
  name: string;
  province: string | null;
}
/** One pickup↔courier edge as enabled on the Flaship side (merchant_pickup_couriers). */
export interface PickupCourierLink {
  pickup_id: string;
  courier_id: string;
}
export interface ExtractedCatalog {
  couriers: CatalogCourier[];
  pickups: CatalogPickup[];
  cities: CatalogCity[];
  links: PickupCourierLink[];
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function unwrap(payload: unknown): Record<string, unknown> {
  let obj = asObject(payload) ?? {};
  for (const key of ["data", "result", "payload", "response"]) {
    const inner = asObject(obj[key]);
    if (inner && ("couriers" in inner || "companies" in inner || "pickups" in inner || "pickupAddress" in inner || "operational_cities" in inner)) {
      return inner;
    }
    if (inner) obj = inner;
  }
  return obj;
}

function firstString(o: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
  }
  return "";
}

/** Extract pickup ids from a company entry's embedded pickup list (ids or objects). */
function pickupIdsFromCompanyEntry(o: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const key of ["pickups", "pickup_locations", "pickupAddress", "pickuplocation", "pickup_ids"]) {
    const list = o[key];
    if (Array.isArray(list)) {
      for (const p of list) {
        if (typeof p === "string" || typeof p === "number") {
          const s = String(p).trim();
          if (s) ids.push(s);
        } else {
          const po = asObject(p);
          if (po) {
            const pid = firstString(po, ["id", "pickup_id", "pickuplocation", "pickuplocation_id", "value"]);
            if (pid) ids.push(pid);
          }
        }
      }
    } else {
      const single = firstString(o, [key]);
      if (single) ids.push(single);
    }
  }
  return [...new Set(ids)];
}

/** Extract courier codes a pickup entry declares itself enabled for. */
function courierCodesFromPickupEntry(o: Record<string, unknown>): string[] {
  const codes: string[] = [];
  for (const key of ["couriers", "companies", "courier", "company", "courier_codes"]) {
    const v = o[key];
    if (Array.isArray(v)) {
      for (const c of v) {
        if (typeof c === "string" || typeof c === "number") {
          const s = String(c).trim();
          if (s) codes.push(s);
        } else {
          const co = asObject(c);
          if (co) {
            const code = firstString(co, ["code", "courier_id", "courier_code", "id", "name"]);
            if (code) codes.push(code);
          }
        }
      }
    } else if (typeof v === "string" || typeof v === "number") {
      const s = String(v).trim();
      if (s) codes.push(s);
    }
  }
  return [...new Set(codes)];
}

function extractCityName(city: unknown): string {
  if (typeof city === "string") return city.trim();
  const o = asObject(city);
  if (o) {
    const name = firstString(o, ["name", "cityname", "city_name", "City", "terminal_name"]);
    if (name) return name;
  }
  return "";
}

/**
 * Normalize the /catalog/ response into couriers / pickups / cities plus the
 * pickup↔courier mapping. Reads the OFFICIAL response keys first
 * (`companies`, `pickupAddress`) and falls back to the legacy shapes. All
 * identifiers keep their ORIGINAL casing — Flaship matches them verbatim.
 */
export function extractCatalog(payload: unknown): ExtractedCatalog {
  const body = unwrap(payload);
  const dataObj = asObject(body.data) ?? {};
  const links: PickupCourierLink[] = [];
  const seenLinks = new Set<string>();
  const addLink = (pickupId: string, courierId: string) => {
    const key = `${pickupId}\u0000${courierId}`;
    if (!pickupId || !courierId || seenLinks.has(key)) return;
    seenLinks.add(key);
    links.push({ pickup_id: pickupId, courier_id: courierId });
  };

  // ---- couriers: official `companies` first, legacy `couriers` fallback ----
  const couriers: CatalogCourier[] = [];
  const courierCodeByIdentity = new Map<string, string>(); // lowercase identity → official code
  const companiesRaw = body.companies ?? body.couriers ?? dataObj.companies ?? dataObj.couriers;
  if (Array.isArray(companiesRaw)) {
    for (const c of companiesRaw) {
      const o = asObject(c);
      if (!o) continue;
      // Original casing preserved — no toLowerCase() anywhere.
      const code = firstString(o, ["code", "courier_code", "courier_id", "company_id", "id", "company", "name"]);
      const label = firstString(o, ["display_name", "name", "title", "company_name"]) || code;
      if (!code) continue;
      couriers.push({ courier_id: code, name: label, code });
      courierCodeByIdentity.set(code.toLowerCase(), code);
      for (const pid of pickupIdsFromCompanyEntry(o)) addLink(pid, code);
    }
  }

  // ---- pickups: official `pickupAddress` first, legacy shapes fallback ----
  const pickups: CatalogPickup[] = [];
  const pickupsRaw = body.pickupAddress ?? body.pickups ?? body.pickup_locations ?? body.pickup_points ?? dataObj.pickupAddress ?? dataObj.pickups;
  if (Array.isArray(pickupsRaw)) {
    for (const p of pickupsRaw) {
      const o = asObject(p);
      if (!o) continue;
      const pid = firstString(o, ["id", "pickup_id", "pickuplocation", "pickuplocation_id", "value"]);
      const name = firstString(o, ["name", "title", "label"]) || pid;
      if (!pid && !name) continue;
      const pickup: CatalogPickup = {
        pickup_id: pid || name,
        name,
        address: firstString(o, ["address", "address_line", "full_address"]) || null,
        city: firstString(o, ["city", "city_name", "cityname"]) || null,
        contact: firstString(o, ["contact", "phone", "contact_number", "mobile"]) || null,
      };
      pickups.push(pickup);
      for (const rawCode of courierCodesFromPickupEntry(o)) {
        // normalize to the official courier code when the pickup side spells it differently
        const code = courierCodeByIdentity.get(rawCode.toLowerCase()) ?? rawCode;
        addLink(pickup.pickup_id, code);
      }
    }
  }

  // ---- cities: keyed list per courier or flat array ----
  const cityMap = new Map<string, CatalogCity>();
  const citiesRaw = body.operational_cities ?? body.cities ?? dataObj.operational_cities;
  if (Array.isArray(citiesRaw)) {
    for (const c of citiesRaw) {
      const name = extractCityName(c);
      if (name) cityMap.set(name.toLowerCase(), { city_id: name.toLowerCase(), name, province: null });
    }
  } else if (asObject(citiesRaw)) {
    for (const list of Object.values(citiesRaw as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      for (const c of list) {
        const name = extractCityName(c);
        if (name) cityMap.set(name.toLowerCase(), { city_id: name.toLowerCase(), name, province: null });
      }
    }
  }

  return { couriers, pickups, cities: [...cityMap.values()], links };
}

// ---------------- Pickup↔courier pair validation ----------------

/**
 * Is (courierId, pickupId) a mapped pair?
 *   true / false — answered from the mapping data.
 *   null         — mapping has no data for this courier (unknown, don't block).
 * When the mapping contains data for the courier, an unmapped pickup is an
 * INVALID pair (Flaship would reject it with merchant_pickup_couriers error).
 */
export function isPairMapped(courierId: string, pickupId: string, links: PickupCourierLink[]): boolean | null {
  const byCourier = links.filter((l) => l.courier_id === courierId);
  if (byCourier.length === 0) return null; // no mapping info for this courier
  return byCourier.some((l) => l.pickup_id === pickupId);
}

/**
 * Filter the pickup list down to those actually mapped to the courier.
 * Graceful degradation: when the mapping is empty (catalog never synced the
 * linkage) the full list is returned so booking keeps working, exactly as
 * before — Flaship remains the final validator.
 */
export function filterPickupsForCourier<T extends { pickup_id: string }>(
  pickups: T[],
  links: PickupCourierLink[],
  courierId: string
): T[] {
  if (!links.length) return pickups;
  const mapped = new Set(links.filter((l) => l.courier_id === courierId).map((l) => l.pickup_id));
  if (mapped.size === 0) return []; // courier known to mapping but has zero pickups → unusable
  return pickups.filter((p) => mapped.has(p.pickup_id));
}

// ---------------- Error message extraction (DRF-style bodies) ----------------

/**
 * Extract a human-readable message from a Flaship error body.
 * Handles, in order:
 *   1. plain string bodies
 *   2. {"message"|"detail"|"error": "..."}  (existing behavior)
 *   3. DRF field-level errors: {"pickup_id": "Pickup is not synced ..."}
 *      or {"field": ["msg1", "msg2"]} / {"non_field_errors": [...]}
 *   4. fallback "Flaship API error (HTTP <status>)"
 */
export function extractApiErrorMessage(body: unknown, status: number): string {
  let parsed = body;
  if (typeof parsed === "string") {
    const text = parsed.trim();
    if (!text) return `Flaship API error (HTTP ${status})`;
    try {
      parsed = JSON.parse(text);
    } catch {
      return text.slice(0, 500);
    }
  }
  const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  if (obj) {
    for (const key of ["message", "detail", "error"]) {
      const v = obj[key];
      if (typeof v === "string" && v.trim()) return v.trim().slice(0, 500);
    }
    // DRF field-level errors: every key whose value is a string or array of strings
    const parts: string[] = [];
    for (const [key, value] of Object.entries(obj)) {
      if (key === "success" || key === "status_code" || key === "status") continue;
      if (typeof value === "string" && value.trim()) {
        parts.push(`${key}: ${value.trim()}`);
      } else if (Array.isArray(value)) {
        const msgs = value.filter((m) => typeof m === "string" && m.trim()).map((m) => String(m).trim());
        if (msgs.length) parts.push(`${key}: ${msgs.join("; ")}`);
      }
    }
    if (parts.length) return parts.join(" | ").slice(0, 500);
  }
  return `Flaship API error (HTTP ${status})`;
}
