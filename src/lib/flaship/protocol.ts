/**
 * Flaship Integration API protocol helpers — PURE functions, no I/O.
 *
 * Technical reference — official Flaship WooCommerce plugin (the vendor's own
 * production client, attached by the merchant 2026-10):
 *   DOCUMENTATION.txt:  Integration API endpoints used:
 *     GET  {base}/catalog/
 *     POST {base}/bookings/
 *     GET  {base}/orders/{tracking_number}/tracking/
 *   Auth: header `X-API-KEY: <per-business Integration API token>`
 *   Base URL "must end with /api/integration/".
 *
 * The create-booking payload is snake_case (pickup_id, courier_code, …);
 * the plugin lowercases courier codes and casts pickup ids to int. The
 * booking response shape is {"success": true, "orderNo": …, "trackingId": …}.
 * The catalog response carries top-level `couriers` ({code, display_name|name}),
 * `pickups` ({id, name, address, city}) and `operational_cities`; the
 * extractor also tolerates the `companies`/`pickupAddress` aliases. Pickup
 * locations embedded inside `companies[]` entries are the merchant_pickup_couriers
 * projection — the ids Flaship's booking validator resolves — so extractCatalog()
 * records them as links AND promotes company-list-only ids to bookable pickup
 * records (verbatim from the catalog; booking with any other pickup id fails
 * with "Pickup is not synced to this courier (missing
 * merchant_pickup_couriers.external_ref).").
 * All
 * identifiers keep their ORIGINAL casing inside our catalog tables — only
 * buildFlashipOrderPayload() applies the plugin's wire transformations.
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

// ---------------- Booking payload (legacy /bookings/ camelCase — retired) ----------------

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

// ---------------- Booking payload (POST /bookings/ — snake_case contract) ----------------

/**
 * OFFICIAL create-booking contract, verified against the official Flaship
 * WooCommerce plugin (the vendor's own production client):
 *   DOCUMENTATION.txt:   "POST {base}/bookings/"  (base URL ends with /api/integration/)
 *   class-flaship-woocommerce-api.php::create_booking() → wp_remote_post($base . 'bookings/')
 *   class-flaship-woocommerce-admin.php::process_bookings() → payload:
 *     pickup_id (int), courier_code (strtolower), service_type (strtolower),
 *     product_name, net_weight, pieces, cod_amount, consignee_name,
 *     consignee_phone_primary, consignee_phone_secondary (''), consignee_address,
 *     consignee_city, special_instruction, external_ref_no
 * `/orders` is NOT a create-booking endpoint — the plugin only ever uses
 * `/orders/{tracking_number}/tracking/` (GET) under the /orders/ prefix.
 *
 * Required keys EXACTLY as Flaship's validator reports them (DRF snake_case):
 *   pickup_id, courier_code, service_type, product_name, net_weight,
 *   cod_amount, consignee_name, consignee_phone_primary, consignee_address,
 *   consignee_city
 * Optional keys sent when available (same names as the plugin): pieces,
 * special_instruction, external_ref_no.
 *
 * Value-fidelity rules (mirroring the plugin exactly):
 *   - courier_code / service_type are LOWERCASED (plugin: strtolower() on the
 *     catalog `code` both at render and submit time).
 *   - pickup_id passes through VERBATIM (the plugin casts to int; DRF's
 *     IntegerField coerces the numeric string identically, so we never
 *     coerce/parse catalog ids ourselves).
 *   - consignee_phone_primary is normalized (+92/92 → 0), plugin-identical.
 *   - consignee_phone_secondary is sent as "" exactly like the plugin.
 */
export interface FlashipOrderPayloadInput {
  /** Verbatim catalog pickup location id. */
  pickupId: string;
  /** Catalog courier code (lowercased on the wire, per the plugin). */
  courierCode: string;
  /** overnight | overland | detain (lowercased on the wire, per the plugin). */
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

/** The exact required-field list Flaship enforces on POST /bookings/. */
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
 * Build the POST /bookings/ body (snake_case, plugin-identical). Pure
 * function — values come from the caller (order / customer / items /
 * settings / booking selection).
 */
export function buildFlashipOrderPayload(input: FlashipOrderPayloadInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    // Value fidelity per the official plugin: pickup_id is the catalog id
    // verbatim (DRF coerces numeric strings; the plugin absint()s because WP
    // form input is always a string); courier_code and service_type are
    // LOWERCASED exactly like the plugin (strtolower) — Flaship's order API
    // matches the lowercase courier codes.
    pickup_id: String(input.pickupId ?? "").trim(),
    courier_code: String(input.courierCode ?? "").trim().toLowerCase(),
    service_type: String(input.serviceType ?? "").trim().toLowerCase() || "overnight",
    product_name: String(input.productName ?? "").trim() || "Products",
    net_weight: Number(input.netWeight ?? 0.5) || 0.5,
    cod_amount: Number(input.codAmount ?? 0) || 0,
    consignee_name: String(input.consigneeName ?? "").trim(),
    consignee_phone_primary: normalizePkPhone(input.consigneePhonePrimary ?? ""),
    consignee_phone_secondary: "", // plugin sends '' explicitly — keep byte-for-byte parity
    consignee_address: String(input.consigneeAddress ?? "").trim(),
    consignee_city: String(input.consigneeCity ?? "").trim(),
  };
  if (input.productPieces !== undefined) {
    // Plugin key name: `pieces` (NOT product_pieces — that was the retired
    // camelCase contract's name).
    payload.pieces = Math.max(1, Number(input.productPieces) || 1);
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

/**
 * One pickup location as embedded in a company (courier) catalog entry.
 * Flaship's own docs: the booking-time pickup id must be the
 * "pickup location ID from company list" — these embedded entries are the
 * merchant_pickup_couriers projection, and their ids/external_refs are the
 * references Flaship's booking validator resolves (DRF error on mismatch:
 * "Pickup is not synced to this courier (missing
 * merchant_pickup_couriers.external_ref).").
 */
interface CompanyPickupEntry {
  pickup_id: string;
  name: string;
  address: string | null;
  city: string | null;
}

/**
 * Extract structured pickup entries from a company entry's embedded pickup
 * list (bare ids or objects). Id-key probe order: explicit ids first, then
 * `external_ref`/`external_ref_no` — the field name Flaship's own validator
 * reports (never fabricated; read verbatim from the entry or not at all).
 */
function pickupEntriesFromCompanyEntry(o: Record<string, unknown>): CompanyPickupEntry[] {
  const out: CompanyPickupEntry[] = [];
  const push = (e: CompanyPickupEntry) => {
    if (e.pickup_id && !out.some((x) => x.pickup_id === e.pickup_id)) out.push(e);
  };
  for (const key of ["pickups", "pickup_locations", "pickupAddress", "pickuplocation", "pickup_ids"]) {
    const list = o[key];
    if (Array.isArray(list)) {
      for (const p of list) {
        if (typeof p === "string" || typeof p === "number") {
          const s = String(p).trim();
          if (s) push({ pickup_id: s, name: "", address: null, city: null });
        } else {
          const po = asObject(p);
          if (po) {
            const pid = firstString(po, [
              "id", "pickup_id", "pickuplocation", "pickuplocation_id", "value",
              "external_ref", "external_ref_no",
            ]);
            if (pid) {
              push({
                pickup_id: pid,
                name: firstString(po, ["name", "title", "label"]),
                address: firstString(po, ["address", "address_line", "full_address"]) || null,
                city: firstString(po, ["city", "city_name", "cityname"]) || null,
              });
            }
          }
        }
      }
    } else {
      const single = firstString(o, [key]);
      if (single) push({ pickup_id: single, name: "", address: null, city: null });
    }
  }
  return out;
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

  // Company-embedded pickup locations (merchant_pickup_couriers projection).
  const companyPickups = new Map<string, CompanyPickupEntry>();

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
      for (const entry of pickupEntriesFromCompanyEntry(o)) {
        addLink(entry.pickup_id, code);
        // Remember the company-list entry so it can be promoted to a bookable
        // pickup record below (Flaship resolves booking pickup ids against
        // exactly this company-list projection).
        if (!companyPickups.has(entry.pickup_id)) companyPickups.set(entry.pickup_id, entry);
      }
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

  // ---- promote company-list-only pickup locations to bookable records ----
  // A pickup location id that appears ONLY inside company entries is still a
  // real Flaship reference (it is what bookings resolve against) — the UI must
  // be able to offer it and the booking must send it. Display name falls back
  // to the id itself; no value is invented.
  for (const [pid, entry] of companyPickups) {
    if (!pickups.some((p) => p.pickup_id === pid)) {
      pickups.push({
        pickup_id: pid,
        name: entry.name || pid,
        address: entry.address,
        city: entry.city,
        contact: null,
      });
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

// ---------------- Pickup↔courier mapping UI helpers ----------------

/**
 * Group pickup→courier links by pickup id (courier ids in first-seen order).
 * Pure helper for the pickup-points admin UI: for every synced pickup it
 * answers "which couriers is this pickup enabled for on the Flaship side
 * (merchant_pickup_couriers)?" — the mapping that decides whether a booking
 * with this pickup would be accepted or rejected with
 * "Pickup is not synced to this courier".
 */
export function couriersByPickup(links: PickupCourierLink[]): Map<string, string[]> {
  const byPickup = new Map<string, string[]>();
  for (const l of links) {
    if (!l.pickup_id || !l.courier_id) continue;
    const list = byPickup.get(l.pickup_id);
    if (list) {
      if (!list.includes(l.courier_id)) list.push(l.courier_id);
    } else {
      byPickup.set(l.pickup_id, [l.courier_id]);
    }
  }
  return byPickup;
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
