/**
 * Flaship Integration API wire format — pure functions, no I/O, no secrets.
 *
 * Field contract (official spec, flaship.pk help → "Create booking via API"):
 *   POST {base}/bookings/
 *   Required fields:
 *     consigneeName, consigneePhone1, consigneeAddress, destinationCity,
 *     codAmount, productName, productWeight, productPieces,
 *     courierCompany (e.g. Leopard, TCS, MNP),
 *     courierOption (overnight / overland / detain),
 *     pickuplocation (pickup location ID from company list)
 *   Sample success response:
 *     { "success": true, "orderNo": 12345, "trackingId": "FLP123456789" }
 *
 * courierCompany and pickuplocation pass through EXACTLY as returned by the
 * Flaship catalog — no lowercasing, no numeric coercion (pure-integer strings
 * restore their JSON number type so the value round-trips the catalog).
 */
import type { Order, OrderItem } from "@/lib/types";

/** Settings fields that feed booking defaults (structural subset of FlashipConfig). */
export interface BookingDefaults {
  default_courier?: string;
  default_service_type?: string;
  default_pickup?: string;
  default_weight?: number;
}

export interface BookingPayloadInput {
  order: Pick<Order, "order_number" | "cod_amount" | "delivery_address" | "city" | "notes">;
  customer?: { name?: string | null; phone?: string | null } | null;
  items?: Pick<OrderItem, "product_name" | "quantity">[];
  cfg: BookingDefaults;
  opts?: { courier?: string; pickup?: string; serviceType?: string; cityId?: string };
}

/** Normalize Pakistani phone formats: +92 / 92 prefixes → leading 0 (per Flaship plugin). */
export function normalizePkPhone(phone: string): string {
  const cleaned = String(phone ?? "").replace(/[^0-9+]/g, "");
  if (cleaned.startsWith("+92")) return `0${cleaned.slice(3)}`;
  if (cleaned.startsWith("92")) return `0${cleaned.slice(2)}`;
  return cleaned;
}

/** Response may be the body itself, { data: {...} }, { result: {...} } etc. */
export function unwrap(payload: unknown): Record<string, unknown> {
  let obj = payload as Record<string, unknown>;
  for (const key of ["data", "result", "payload", "response"]) {
    if (obj && typeof obj === "object" && obj[key] && typeof obj[key] === "object" && !Array.isArray(obj[key])) {
      const inner = obj[key] as Record<string, unknown>;
      if ("couriers" in inner || "pickups" in inner || "operational_cities" in inner) return inner;
      obj = inner;
    }
  }
  return obj ?? {};
}

/** Catalog IDs pass through verbatim; pure-integer strings restore their JSON number type. */
function catalogId(value: unknown): string | number {
  const s = String(value ?? "").trim();
  if (!s) return "";
  return /^\d+$/.test(s) ? Number(s) : s;
}

/** Build the POST /bookings/ body with the official camelCase field names. */
export function buildFlashipBookingPayload(input: BookingPayloadInput): Record<string, unknown> {
  const { order, customer, items = [], cfg, opts } = input;
  const productName = items.length
    ? items.map((i) => `${i.product_name} (x${i.quantity})`).join(" -- ")
    : "Products";
  const pieces = Math.max(1, items.reduce((sum, i) => sum + (Number(i.quantity) || 1), 0));
  const weight = Number(cfg.default_weight ?? 0.5);

  return {
    pickuplocation: catalogId(opts?.pickup ?? cfg.default_pickup),
    courierCompany: String(opts?.courier ?? cfg.default_courier ?? "").trim(),
    courierOption: String(opts?.serviceType ?? cfg.default_service_type ?? "overnight").trim().toLowerCase(),
    productName,
    productWeight: Number.isFinite(weight) ? weight : 0.5,
    productPieces: pieces,
    codAmount: Number(order.cod_amount ?? 0),
    consigneeName: customer?.name ?? "Customer",
    consigneePhone1: normalizePkPhone(customer?.phone ?? ""),
    consigneeAddress: order.delivery_address,
    destinationCity: order.city,
    specialInstruction: order.notes ?? "",
    externalRefNo: order.order_number,
  };
}

export interface BookingIdentifiers {
  bookingId: string;
  cn: string;
  courierCode: string;
  /** Unwrapped response body, for any additional fields the caller needs. */
  body: Record<string, unknown>;
}

/** Parse a booking response — official keys first (orderNo/trackingId), legacy fallbacks kept. */
export function extractBookingIdentifiers(result: unknown): BookingIdentifiers {
  const body = unwrap(result);
  const bookingId = String(
    body.orderNo ?? body.order_no ?? body.id ?? body.booking_id ?? body.bookingId ?? body.externalRefNo ?? body.external_ref_no ?? ""
  );
  const cn = String(body.trackingId ?? body.tracking_id ?? body.tracking_number ?? body.trackingNumber ?? body.cn ?? "");
  const courierCode = String(body.courierCompany ?? body.courier_company ?? body.courier_code ?? body.courierCode ?? "").trim();
  return { bookingId: bookingId || `FLB${Date.now()}`, cn, courierCode, body };
}
