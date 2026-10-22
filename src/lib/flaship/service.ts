import "server-only";
import { store, IS_DEMO_MODE } from "@/lib/store";
import type { FlashipCourier, FlashipCity, FlashipPickup, Order, OrderItem } from "@/lib/types";
import { decryptSecret } from "@/lib/crypto/secret-box";
import {
  buildFlashipOrderPayload,
  catalogResponseDiagnostics,
  extractApiErrorMessage,
  extractCatalog,
  findMissingBookingFields,
  isPairMapped,
  parseBookingResponse,
  type CatalogDiagnostics,
  type ExtractedCatalog,
} from "@/lib/flaship/protocol";
import { logAudit, type Actor } from "@/lib/services/audit";
import { notifyAdmins } from "@/lib/services/notifications";
import { changeOrderStatus } from "@/lib/services/orders";
import { canTransition } from "@/lib/services/order_transitions";
import { enqueueWhatsAppOrderEvent } from "@/lib/services/whatsapp";

export class FlashipError extends Error {}

/**
 * Flaship Integration API client — server-side only.
 *
 * Technical reference — OFFICIAL Flaship WooCommerce plugin (the vendor's own
 * production client, attached by the merchant 2026-10):
 *   GET  {base}/catalog/            → couriers, pickups, operational_cities
 *   POST {base}/bookings/           → snake_case payload (pickup_id, courier_code,
 *                                     service_type, product_name, net_weight, cod_amount,
 *                                     consignee_name, consignee_phone_primary,
 *                                     consignee_address, consignee_city) — booking is
 *                                     created at /bookings/ ONLY; the /orders/ prefix is
 *                                     used exclusively by tracking
 *                                     (GET /orders/{cn}/tracking/)
 *   Success: {"success": true, "orderNo": 12345, "trackingId": "FLP123456789"}
 *   GET  {base}/orders/{cn}/tracking/  → tracking + history
 *   Auth: header `X-API-KEY: <integration token>`
 *   Base URL must point at the Integration API root (…/api/integration/).
 *
 * Pure protocol helpers (payload builder, catalog extraction incl. the
 * pickup↔courier mapping, DRF-style error parsing) live in ./protocol.ts and
 * are unit-tested in tests/flaship_protocol.test.ts.
 *
 * The API key never leaves the server: env FLASHIP_API_KEY wins, otherwise an
 * AES-256-GCM encrypted copy stored in the settings table. Logs are redacted.
 */
export interface FlashipConfig {
  base_url: string;
  api_key_set: boolean;
  mode: "live" | "simulator";
  timeout_ms: number;
  endpoints: { catalog: string; bookings: string; tracking: string };
  default_courier?: string;
  default_service_type?: string;
  default_pickup?: string;
  default_weight?: number;
  auto_sync_tracking?: boolean;
}

const DEFAULT_BASE_URL = process.env.FLASHIP_API_BASE_URL || "https://partners.flaship.pk/api/integration";

const DEFAULT_CONFIG: FlashipConfig = {
  base_url: DEFAULT_BASE_URL,
  api_key_set: !!process.env.FLASHIP_API_KEY,
  mode: process.env.FLASHIP_API_KEY ? "live" : "simulator",
  timeout_ms: 30000,
  endpoints: { catalog: "/catalog/", bookings: "/bookings/", tracking: "/orders/{cn}/tracking/" },
  default_service_type: "overnight",
  default_weight: 0.5,
};

interface StoredFlashipSettings {
  base_url?: string;
  api_key_enc?: string;
  api_key_masked?: string;
  mode?: "live" | "simulator";
  timeout_ms?: number;
  endpoints?: Partial<FlashipConfig["endpoints"]>;
  default_courier?: string;
  default_service_type?: string;
  default_pickup?: string;
  default_weight?: number;
  auto_sync_tracking?: boolean;
}

/** Load Flaship settings (DB overrides env defaults). Server-side only. */
export async function getFlashipConfig(): Promise<FlashipConfig> {
  const row = await store.first<{ value: StoredFlashipSettings }>("settings", { key: "flaship" });
  const v = row?.value ?? {};
  const envKey = !!process.env.FLASHIP_API_KEY;
  const dbKey = !!v.api_key_enc;
  const mode: FlashipConfig["mode"] =
    envKey || dbKey ? ((v.mode as FlashipConfig["mode"]) === "simulator" ? "simulator" : "live") : "simulator";
  const storedEndpoints = { ...(v.endpoints || {}) };
  // Endpoint healing: the official Flaship WooCommerce plugin creates bookings
  // at POST {base}bookings/ (base ends with /api/integration/) — /orders is
  // tracking-only. Our own 2026-10 hotfix briefly defaulted bookings to
  // "/orders" (and rewrote the correct stored "/bookings/" to "/orders"),
  // which does NOT match the vendor client. Heal any stored "/orders" back to
  // the official "/bookings/"; the correct stored "/bookings/" passes through
  // untouched. Same-path variants without the trailing slash are normalized
  // so Django's APPEND_SLASH redirect can never turn the POST into a GET.
  if (storedEndpoints.bookings === "/orders" || storedEndpoints.bookings === "/orders/" || storedEndpoints.bookings === "/bookings") {
    storedEndpoints.bookings = DEFAULT_CONFIG.endpoints.bookings;
  }
  return {
    ...DEFAULT_CONFIG,
    ...v,
    endpoints: { ...DEFAULT_CONFIG.endpoints, ...storedEndpoints },
    api_key_set: envKey || dbKey,
    mode,
  };
}

/** Resolve the API key server-side: env first, then the encrypted DB copy. */
async function resolveApiKey(v: StoredFlashipSettings | null): Promise<string | null> {
  if (process.env.FLASHIP_API_KEY) return process.env.FLASHIP_API_KEY;
  const enc = v?.api_key_enc;
  if (enc) return decryptSecret(enc);
  return null;
}

async function loadStoredSettings(): Promise<StoredFlashipSettings> {
  const row = await store.first<{ value: StoredFlashipSettings }>("settings", { key: "flaship" });
  return row?.value ?? {};
}

/** Persist settings values (used by the settings API to save the encrypted key). */
export async function saveFlashipSettings(patch: Partial<StoredFlashipSettings>): Promise<void> {
  const current = await loadStoredSettings();
  const next = { ...current, ...patch };
  // A stored API key means the real Flaship integration is configured, so saving
  // a key through PATCH /api/settings activates live mode automatically (no UI
  // toggle). With no key stored, mode is left untouched — the simulator keeps
  // working for development/demo.
  if (next.api_key_enc) next.mode = "live";
  const existing = await store.first("settings", { key: "flaship" });
  if (existing) await store.update("settings", existing.id, { value: next, updated_at: new Date().toISOString() });
  else await store.insert("settings", { key: "flaship", value: next });
}

/** Masked key hint for display (never the full key). */
export async function getFlashipKeyHint(): Promise<{ api_key_set: boolean; api_key_masked: string | null; source: "env" | "database" | null }> {
  const stored = await loadStoredSettings();
  if (process.env.FLASHIP_API_KEY) {
    const tail = process.env.FLASHIP_API_KEY.slice(-4);
    return { api_key_set: true, api_key_masked: `••••••••${tail}`, source: "env" };
  }
  const dec = decryptSecret(stored.api_key_enc);
  if (dec) return { api_key_set: true, api_key_masked: `••••••••${dec.slice(-4)}`, source: "database" };
  return { api_key_set: false, api_key_masked: null, source: null };
}

/** Redact anything that looks like a secret before writing to logs. */
function redact(text: string): string {
  return text
    .replace(/(x-api-key"?\s*[:=]\s*"?)[^",}&]+/gi, "$1***REDACTED***")
    .replace(/(api[_-]?key"?\s*[:=]\s*"?)[^",}&]+/gi, "$1***REDACTED***")
    .replace(/(authorization"?\s*[:=]\s*"?)[^",}&]+/gi, "$1***REDACTED***")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer ***REDACTED***");
}

async function writeLog(params: {
  orderId?: string | null;
  endpoint: string;
  method: string;
  statusCode: number | null;
  success: boolean;
  durationMs: number;
  request?: unknown;
  response?: unknown;
  error?: string | null;
}) {
  try {
    await store.insert("flaship_logs", {
      order_id: params.orderId ?? null,
      endpoint: params.endpoint,
      method: params.method,
      status_code: params.statusCode,
      success: params.success,
      duration_ms: params.durationMs,
      request_redacted: params.request ? redact(JSON.stringify(params.request)) : null,
      response: params.response ? redact(typeof params.response === "string" ? params.response : JSON.stringify(params.response)).slice(0, 4000) : null,
      error: params.error ?? null,
    });
  } catch (e) {
    console.error("[flaship] log write failed", e);
  }
}

// ---------------- Simulator (demo mode) ----------------

function simulate<T>(data: T, ms = 350): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(data), ms));
}

async function simulateCatalog(type: "couriers" | "cities" | "pickups") {
  const table = type === "couriers" ? "flaship_couriers" : type === "cities" ? "flaship_cities" : "flaship_pickups";
  const { rows } = await store.list(table);
  return rows;
}

function simulateBooking(payload: Record<string, unknown>) {
  // Mirrors the OFFICIAL success shape ({success, orderNo, trackingId}) so the
  // simulator exercises exactly the same response parser as the live API.
  const cn = `FLP${Math.floor(1000000000 + Math.random() * 9000000000)}`;
  return simulate({
    success: true,
    orderNo: Math.floor(100000 + Math.random() * 899999),
    trackingId: cn,
    courierCompany: payload.courier_code ?? payload.courierCompany,
    status: "BOOKED",
    message: "Booking created successfully (simulated)",
  });
}

function simulateTracking(cn: string, order?: Order) {
  const steps = ["BOOKED", "PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED"];
  const current = order?.status === "DELIVERED" ? 4 : order?.status === "IN_TRANSIT" ? 2 : order?.status === "RETURNED" ? 2 : 1;
  const idx = Math.min(steps.length - 1, current + (Math.random() > 0.6 ? 1 : 0));
  return simulate({
    success: true,
    tracking_number: cn,
    order_status: steps[idx],
    tracking_history: steps.slice(0, idx + 1).map((s, i) => ({
      status: s,
      description:
        s === "BOOKED" ? "Booking confirmed with courier"
        : s === "PICKED_UP" ? "Parcel picked up from warehouse"
        : s === "IN_TRANSIT" ? "In transit to destination"
        : s === "OUT_FOR_DELIVERY" ? "Out for delivery"
        : "Delivered — COD collected",
      location: order?.city ?? "Karachi",
      time: new Date(Date.now() - (idx - i) * 86400000).toISOString(),
    })),
  });
}

// ---------------- Live HTTP client (X-API-KEY auth) ----------------

function joinUrl(base: string, path: string): string {
  const b = base.endsWith("/") ? base : `${base}/`;
  const p = path.startsWith("/") ? path.slice(1) : path;
  return `${b}${p}`;
}

async function liveRequest<T>(
  cfg: FlashipConfig,
  path: string,
  options: { method?: string; body?: unknown; orderId?: string | null } = {}
): Promise<T> {
  const apiKey = await resolveApiKey(await loadStoredSettings());
  if (!apiKey) throw new FlashipError("Flaship API key is not configured on the server.");
  const url = joinUrl(cfg.base_url, path);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeout_ms || 30000);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-API-KEY": apiKey,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep raw text */
    }
    const duration = Date.now() - started;
    const success = res.ok;
    await writeLog({
      orderId: options.orderId,
      endpoint: path,
      method: options.method ?? "GET",
      statusCode: res.status,
      success,
      durationMs: duration,
      request: options.body,
      response: parsed,
      error: success ? null : `HTTP ${res.status}`,
    });
    if (!res.ok) {
      // Surfaced field-level DRF errors too, e.g.
      // {"pickup_id":"Pickup is not synced to this courier …"} → shown verbatim.
      throw new FlashipError(extractApiErrorMessage(parsed, res.status));
    }
    return parsed as T;
  } catch (e) {
    const duration = Date.now() - started;
    const isTimeout = e instanceof Error && e.name === "AbortError";
    if (!(e instanceof FlashipError)) {
      await writeLog({
        orderId: options.orderId,
        endpoint: path,
        method: options.method ?? "GET",
        statusCode: null,
        success: false,
        durationMs: duration,
        request: options.body,
        error: isTimeout ? `Request timed out after ${cfg.timeout_ms}ms` : String(e),
      });
    }
    if (isTimeout) throw new FlashipError(`Flaship request timed out after ${Math.round((cfg.timeout_ms || 30000) / 1000)}s. Please retry.`);
    if (e instanceof FlashipError) throw e;
    throw new FlashipError("Could not reach the Flaship API. Please check connectivity and retry.");
  } finally {
    clearTimeout(timer);
  }
}

// ---------------- Catalog (GET /catalog/) ----------------
// Extraction lives in protocol.ts (pure + unit-tested): extractCatalog() reads
// the official response keys (`companies`, `pickupAddress`) with legacy
// fallbacks, preserves the ORIGINAL identifier casing, and returns the
// pickup↔courier mapping (`links`) alongside couriers / pickups / cities.

/** Fetch + persist the catalog (couriers / cities / pickups + pickup↔courier mapping). */
export async function syncCatalog(
  type: "couriers" | "cities" | "pickups" | "all"
): Promise<{ couriers: number; cities: number; pickups: number; links: number; diagnostics: CatalogDiagnostics | null }> {
  const cfg = await getFlashipConfig();
  let catalog: ExtractedCatalog;
  let diagnostics: CatalogDiagnostics | null = null;

  if (cfg.mode === "live") {
    const res = await liveRequest<unknown>(cfg, cfg.endpoints.catalog);
    catalog = extractCatalog(res);
    if (!catalog.couriers.length && !catalog.cities.length && !catalog.pickups.length) {
      throw new FlashipError("Flaship catalog response was empty. Verify the API key and base URL.");
    }
    // Shape diagnostics: lets the admin see exactly which sections the live
    // response contained when the courier-pickup pair count stays 0 — the
    // honest way to identify missing Flaship-side configuration.
    diagnostics = catalogResponseDiagnostics(res);
  } else {
    const [couriers, cities, pickups] = await Promise.all([
      simulateCatalog("couriers") as Promise<Record<string, unknown>[]>,
      simulateCatalog("cities") as Promise<Record<string, unknown>[]>,
      simulateCatalog("pickups") as Promise<Record<string, unknown>[]>,
    ]);
    catalog = {
      couriers: couriers as unknown as ExtractedCatalog["couriers"],
      cities: cities as unknown as ExtractedCatalog["cities"],
      pickups: pickups as unknown as ExtractedCatalog["pickups"],
      links: [],
    };
  }

  const now = new Date().toISOString();
  const counts = { couriers: 0, cities: 0, pickups: 0, links: 0 };

  // The catalog is persisted with bulk upserts keyed on each table's UNIQUE
  // business column(s) (courier_id / city_id / pickup_id / pickup_id+courier_id).
  // Conflict resolution happens in the database on the constraint itself:
  // safe at any size and idempotent across repeat refreshes.
  if (type === "couriers" || type === "all") {
    const byId = new Map<string, Record<string, unknown>>();
    for (const item of catalog.couriers) {
      const cid = item.courier_id.trim();
      const name = item.name.trim();
      if (!cid || !name) continue;
      // Original casing preserved — Flaship matches courierCompany verbatim.
      byId.set(cid, { courier_id: cid, name, active: true, synced_at: now });
    }
    if (byId.size) {
      await store.upsertMany("flaship_couriers", [...byId.values()], ["courier_id"]);
      // Deactivate rows the fresh catalog no longer reports (e.g. courier ids
      // stored lowercased by older sync versions) so the UI never offers a
      // value Flaship would reject.
      const { rows: existing } = await store.list<{ id: string; courier_id: string; active: boolean }>("flaship_couriers");
      for (const row of existing) {
        if (!byId.has(row.courier_id) && row.active !== false) {
          await store.update("flaship_couriers", row.id, { active: false });
        }
      }
    }
    counts.couriers = byId.size;
  }
  if (type === "cities" || type === "all") {
    const byId = new Map<string, Record<string, unknown>>();
    for (const item of catalog.cities) {
      const name = item.name.trim();
      if (!name) continue;
      const cid = item.city_id || name.toLowerCase();
      byId.set(cid, { city_id: cid, name, province: item.province ?? null, active: true, synced_at: now });
    }
    if (byId.size) await store.upsertMany("flaship_cities", [...byId.values()], ["city_id"]);
    counts.cities = byId.size;
  }
  if (type === "pickups" || type === "all") {
    const byId = new Map<string, Record<string, unknown>>();
    for (const item of catalog.pickups) {
      const pid = item.pickup_id.trim();
      const name = item.name.trim();
      if (!pid || !name) continue;
      byId.set(pid, { pickup_id: pid, name, address: item.address, city: item.city, contact: item.contact, active: true, synced_at: now });
    }
    if (byId.size) {
      await store.upsertMany("flaship_pickups", [...byId.values()], ["pickup_id"]);
      const { rows: existing } = await store.list<{ id: string; pickup_id: string; active: boolean }>("flaship_pickups");
      for (const row of existing) {
        if (!byId.has(row.pickup_id) && row.active !== false) {
          await store.update("flaship_pickups", row.id, { active: false });
        }
      }
    }
    counts.pickups = byId.size;
  }

  // Persist the pickup↔courier mapping (Flaship's merchant_pickup_couriers) so
  // the booking UI offers only pairs Flaship accepts. Every live sync entry
  // point (couriers / cities / pickups / all) refreshes it: the /catalog/
  // response is fetched and parsed as a whole, so the links are complete no
  // matter which type the caller asked for — syncing from the pickup-points
  // page therefore also refreshes the courier mapping. Full refresh: edges
  // absent from the fresh catalog are removed — but ONLY when the fresh
  // catalog actually reported links, so an unrecognized response shape never
  // wipes existing mapping data.
  if (cfg.mode === "live" && catalog.links.length) {
    await store.upsertMany(
      "flaship_pickup_couriers",
      catalog.links.map((l) => ({ pickup_id: l.pickup_id, courier_id: l.courier_id, synced_at: now })),
      ["pickup_id", "courier_id"]
    );
    const { rows: existingLinks } = await store.list<{ id: string; pickup_id: string; courier_id: string }>("flaship_pickup_couriers");
    const fresh = new Set(catalog.links.map((l) => `${l.pickup_id}\u0000${l.courier_id}`));
    for (const row of existingLinks) {
      if (!fresh.has(`${row.pickup_id}\u0000${row.courier_id}`)) await store.delete("flaship_pickup_couriers", row.id);
    }
    counts.links = catalog.links.length;
  }
  return { ...counts, diagnostics };
}

export async function listCouriers(): Promise<FlashipCourier[]> {
  const { rows } = await store.list<FlashipCourier>("flaship_couriers", { filters: { active: true }, orderBy: { field: "name", dir: "asc" } });
  return rows;
}
export async function listCities(): Promise<FlashipCity[]> {
  const { rows } = await store.list<FlashipCity>("flaship_cities", { filters: { active: true }, orderBy: { field: "name", dir: "asc" } });
  return rows;
}
export async function listPickups(): Promise<FlashipPickup[]> {
  const { rows } = await store.list<FlashipPickup>("flaship_pickups", { filters: { active: true }, orderBy: { field: "name", dir: "asc" } });
  return rows;
}

/** Quick connectivity/credentials check used by the admin "Test connection" button. */
export async function testFlashipConnection(): Promise<{ ok: boolean; message: string; mode: FlashipConfig["mode"] }> {
  const cfg = await getFlashipConfig();
  if (cfg.mode !== "live") {
    return { ok: true, message: "Simulator mode active — bookings are generated locally until a live API key is configured.", mode: "simulator" };
  }
  try {
    const res = await liveRequest<unknown>(cfg, cfg.endpoints.catalog);
    const catalog = extractCatalog(res);
    const diagnostics = catalogResponseDiagnostics(res);
    let message = `Connected. Catalog loaded: ${catalog.couriers.length} courier(s), ${catalog.cities.length} cit(ies), ${catalog.pickups.length} pickup location(s), ${catalog.links.length} courier-pickup link(s).`;
    if (catalog.links.length === 0) {
      // Honest diagnostics instead of a vague warning: report the shape so the
      // merchant can tell "Flaship did not expose the mapping" apart from
      // "nothing is enabled on the Flaship side".
      const shape = [
        diagnostics.companies !== null ? `companies(${diagnostics.companies})` : null,
        diagnostics.couriers !== null ? `couriers(${diagnostics.couriers})` : null,
        diagnostics.pickupAddress !== null ? `pickupAddress(${diagnostics.pickupAddress})` : null,
        diagnostics.pickups !== null ? `pickups(${diagnostics.pickups})` : null,
      ]
        .filter(Boolean)
        .join(", ");
      message +=
        " No courier-pickup mapping is present in the catalog response" +
        (shape ? ` (sections seen: ${shape})` : "") +
        ". Booking still works — with no mapping stored, Flaship itself validates each booking. To have pairs reported here, enable couriers for your pickup locations in the Flaship merchant dashboard, then sync again.";
    }
    return {
      ok: true,
      message,
      mode: "live",
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Connection failed.", mode: "live" };
  }
}

// ---------------- Booking (POST /bookings/ — official create-booking endpoint) ----------------

export interface BookingResult {
  bookingId: string;
  trackingNumber: string;
  courierName: string;
}

/** Normalizes Pakistani phone formats (+92/92 → 0). Implementation lives in protocol.ts. */
export { normalizePkPhone } from "@/lib/flaship/protocol";

/**
 * Book an order with Flaship (server-side only).
 * Duplicate prevention: refuses to book when a booking id / CN already exists.
 */
export async function bookOrderWithFlaship(session: Actor | null, orderId: string, opts?: { courier?: string; pickup?: string; serviceType?: string; cityId?: string }): Promise<BookingResult> {
  const order = await store.get<Order>("orders", orderId);
  if (!order) throw new FlashipError("Order not found.");

  // ---- APPROVAL GATE (critical security rule) ----
  // Flaship must NEVER be called for an order that has not been approved by an
  // admin. Worker-submitted orders are PENDING until an admin approves them;
  // rejected orders can never be booked. Orders created before the approval
  // workflow (or directly by admins) carry approval_status = 'APPROVED'.
  if (order.approval_status && order.approval_status !== "APPROVED") {
    await logAudit({
      session,
      action: "flaship.booking_blocked",
      entity: "orders",
      entityId: orderId,
      newData: { reason: `approval_status=${order.approval_status}`, order_number: order.order_number },
    });
    throw new FlashipError(
      `Order ${order.order_number} has not been approved yet — Flaship booking is blocked until an admin approves it.`
    );
  }

  // ---- duplicate prevention ----
  if (order.flaship_booking_id || order.tracking_number || order.booking_status === "booked") {
    throw new FlashipError(`Order ${order.order_number} is already booked (CN ${order.tracking_number}). Duplicate bookings are blocked.`);
  }
  if (["DELIVERED", "RETURNED", "CANCELLED"].includes(order.status)) {
    throw new FlashipError(`Order ${order.order_number} is closed and cannot be booked.`);
  }

  // ---- concurrent-booking guard (double-click / parallel retry race) ----
  // booking_status "pending" means another request is mid-flight between the
  // pending write below and its final booked/failed write. Blocking it
  // prevents two Flaship POSTs (two CNs) for the same order. Stale-pending
  // recovery: if the pending stamp is older than the request could possibly
  // be in flight (2× the configured timeout, floor 5 min — a crashed process
  // never wrote its result), the retry is allowed instead of bricking the
  // order. Orders whose pending row predates updated_at stamping are allowed
  // through (legacy rows — no recency signal, previous behavior preserved).
  if (order.booking_status === "pending") {
    const cfgEarly = await getFlashipConfig();
    const staleAfterMs = Math.max(5 * 60_000, 2 * (cfgEarly.timeout_ms || 30_000));
    const stampedAt = order.updated_at ? new Date(order.updated_at).getTime() : 0;
    const isInFlight = stampedAt > 0 && Date.now() - stampedAt < staleAfterMs;
    if (isInFlight) {
      throw new FlashipError(
        `A booking attempt for order ${order.order_number} is already in progress. Wait a moment and retry — if it stays stuck for minutes, retrying is safe.`
      );
    }
  }

  const cfg = await getFlashipConfig();
  const customer = await store.get<{ name: string; phone: string; email: string | null }>("customers", order.customer_id);
  const { rows: items } = await store.list<OrderItem>("order_items", { filters: { order_id: orderId }, perPage: 50 });
  const productName = items.length
    ? items.map((i) => `${i.product_name} (x${i.quantity})`).join(" -- ")
    : "Products";
  const pieces = Math.max(1, items.reduce((sum, i) => sum + (Number(i.quantity) || 1), 0));

  // ---- courier / pickup selection (values pass through VERBATIM) ----
  // Flaship matches both values case-sensitively against its
  // merchant_pickup_couriers mapping — NEVER lowercase or parseInt them.
  const courierCompany = String(opts?.courier ?? cfg.default_courier ?? "").trim();
  const pickuplocation = String(opts?.pickup ?? cfg.default_pickup ?? "").trim();
  if (!courierCompany) throw new FlashipError("Select a courier company before booking.");
  if (!pickuplocation) throw new FlashipError("Select a pickup location before booking.");
  const courierOption = String(opts?.serviceType ?? cfg.default_service_type ?? "overnight").trim();

  // ---- server-side pair guard (live mode, when mapping data exists) ----
  // Blocks exactly the production failure mode
  // {"pickup_id":"Pickup is not synced to this courier …"} before the API call.
  // No mapping data for the courier → don't block (Flaship stays the validator).
  if (cfg.mode === "live") {
    const { rows: mapped } = await store.list<{ pickup_id: string; courier_id: string }>("flaship_pickup_couriers", {
      filters: { courier_id: courierCompany },
    });
    if (isPairMapped(courierCompany, pickuplocation, mapped) === false) {
      throw new FlashipError(
        `Pickup "${pickuplocation}" is not enabled for courier "${courierCompany}". Re-sync the Flaship catalog and pick a mapped pickup location.`
      );
    }
  }

  // ---- completeness gate (fail fast, zero side effects) ----
  // Build the official /bookings/ payload (snake_case, plugin-identical) from
  // REAL order data — customer, delivery address, city, COD amount, order
  // items, settings and the courier/pickup selection. NEVER hardcoded. If any
  // field Flaship requires is missing, abort BEFORE touching booking state or
  // calling the API, and say exactly which fields are missing.
  const payload = buildFlashipOrderPayload({
    pickupId: pickuplocation,
    courierCode: courierCompany,
    serviceType: courierOption,
    productName,
    netWeight: Number(cfg.default_weight ?? 0.5),
    codAmount: Number(order.cod_amount ?? 0),
    consigneeName: customer?.name ?? "",
    consigneePhonePrimary: customer?.phone ?? "",
    consigneeAddress: order.delivery_address ?? "",
    consigneeCity: order.city ?? "",
    productPieces: pieces,
    specialInstruction: order.notes ?? "",
    externalRefNo: order.order_number,
  });
  const missing = findMissingBookingFields(payload);
  if (missing.length) {
    throw new FlashipError(
      `Flaship booking payload incomplete — missing required field(s): ${missing.join(", ")}. ` +
        "Check the order's customer name/phone, delivery address, city, COD amount and the courier/pickup selection before booking."
    );
  }

  // mark as pending so concurrent clicks don't double-book; updated_at is the
  // recency stamp the concurrent-booking guard above reads (orders.updated_at
  // has no DB trigger — it is stamped here explicitly, write-only metadata).
  await store.update("orders", orderId, { booking_status: "pending", updated_at: new Date().toISOString() });

  try {
    let result: Record<string, unknown>;

    if (cfg.mode === "live") {
      result = await liveRequest<Record<string, unknown>>(cfg, cfg.endpoints.bookings, {
        method: "POST",
        body: payload,
        orderId,
      });
    } else {
      result = (await simulateBooking(payload)) as Record<string, unknown>;
    }

    // Official success response: {"success": true, "orderNo": 12345, "trackingId": "FLP…"}
    const { bookingId, trackingNumber: cn, courierName } = parseBookingResponse(result, courierCompany);

    await store.update("orders", orderId, {
      booking_status: "booked",
      flaship_booking_id: bookingId,
      tracking_number: cn,
      flaship_courier_name: courierName,
      pickup_location_name: pickuplocation,
      booking_error: null,
      booked_at: new Date().toISOString(),
    });

    await store.insert("shipments", {
      order_id: orderId,
      courier_name: courierName,
      tracking_number: cn,
      booking_id: bookingId,
      destination_city: order.city,
      pickup_location: pickuplocation,
      shipment_status: "BOOKED",
      booked_at: new Date().toISOString(),
      last_synced_at: null,
    });

    if (order.status !== "BOOKED" && order.status !== "IN_TRANSIT") {
      await changeOrderStatus(session ?? { userId: "system" }, orderId, "BOOKED", `Booked with ${courierName}`);
    } else {
      // Partial-failure recovery: the order already reached BOOKED/IN_TRANSIT
      // in a previous attempt whose booking write failed afterwards. The
      // booking itself just succeeded (CN allocated) — make sure the BOOKED
      // customer notification is enqueued. Idempotent: services/whatsapp.ts
      // dedupes on (order, type, recipient) and never throws.
      await enqueueWhatsAppOrderEvent({ orderId, type: "BOOKED" });
    }

    await logAudit({
      session,
      action: "flaship.booking_created",
      entity: "orders",
      entityId: orderId,
      newData: { booking_id: bookingId, cn, courier: courierName },
    });
    return { bookingId, trackingNumber: cn, courierName };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Flaship booking failed.";
    await store.update("orders", orderId, { booking_status: "failed", booking_error: message });
    await notifyAdmins({
      title: "Flaship booking failed",
      message: `Booking for order ${order.order_number} failed: ${message}`,
      type: "error",
      link: `/admin/orders/${orderId}`,
    });
    await logAudit({
      session,
      action: "flaship.booking_failed",
      entity: "orders",
      entityId: orderId,
      newData: { error: message },
    });
    throw e instanceof FlashipError ? e : new FlashipError(message);
  }
}

// ---------------- Tracking (GET /orders/{cn}/tracking/) ----------------

const STATUS_MAP: Record<string, { status?: "IN_TRANSIT" | "DELIVERED" | "RETURNED"; label: string }> = {
  BOOKED: { label: "Booked" },
  PICKED_UP: { status: "IN_TRANSIT", label: "Picked up" },
  IN_TRANSIT: { status: "IN_TRANSIT", label: "In transit" },
  OUT_FOR_DELIVERY: { status: "IN_TRANSIT", label: "Out for delivery" },
  // Leopards scans "ASSIGNED TO COURIER IN <city>" when the destination-hub
  // rider receives the parcel — the step BEFORE Leopards' own "Out for
  // Delivery" scan (verified: Leopards status flow Booked → Dispatched →
  // Arrived at Hub → Assigned to Courier → Out for Delivery → Delivered;
  // vendor integrations map it to In transit). Order goes IN_TRANSIT; the
  // customer OUT_FOR_DELIVERY WhatsApp still waits for the courier's actual
  // out-for-delivery scan.
  ASSIGNED_TO_COURIER: { status: "IN_TRANSIT", label: "Assigned to courier" },
  DELIVERED: { status: "DELIVERED", label: "Delivered" },
  RETURNED: { status: "RETURNED", label: "Returned" },
  RTO: { status: "RETURNED", label: "Return to origin" },
  RTO_INTRANSIT: { status: "RETURNED", label: "Return to origin (in transit)" },
  RETURN_TO_SHIPPER: { status: "RETURNED", label: "Return to shipper" },
  CANCELLED: { label: "Cancelled" },
};

const CANONICAL_COURIER_STATUSES = new Set(Object.keys(STATUS_MAP));

/**
 * Map a raw courier checkpoint string to the canonical STATUS_MAP key.
 *
 * Root cause fixed here (2026-10 tracking-sync bug): Leopards (via Flaship)
 * emits free-text checkpoints — "ASSIGNED TO COURIER IN SARGODHA", "SHIPMENT
 * PICKED IN LAHORE", "ARRIVED AT STATION IN MULTAN", "DISPATCHED TO
 * SARGODHA", "DELIVERED TO WAREHOUSE" — none of which are exact STATUS_MAP
 * keys, so the old exact-match lookup left the order stuck at BOOKED while
 * checkpoints kept accumulating; every later sync then correctly reported
 * "Tracking is up to date." even though the order status was stale, and the
 * WhatsApp triggers (exact raw strings) never fired either.
 *
 * Verified Leopards semantics (Leopards status guide 2026-07; ShipOps
 * Leopards integration notes checked against Leopards docs 2026-10):
 *   Booked → Dispatched → Arrived at Hub → Assigned to Courier →
 *   Out for Delivery → Delivered
 *   - "Assigned to courier in {city}" = rider assigned at the hub, delivery
 *     attempt within ~4-8h — the step BEFORE "Out for Delivery", so it maps
 *     to In transit (NOT out for delivery, and no customer OFD message).
 *   - "Delivered to Warehouse / Vendor" words a RETURN that reached the
 *     merchant — it must never mark the order DELIVERED.
 * Unknown strings pass through unchanged (canonical underscore form), so the
 * downstream exact-match lookup behaves exactly as before: unknown stays
 * unmapped and no order status changes.
 */
export function normalizeCourierStatus(raw: unknown): string {
  const spaced = String(raw ?? "").toUpperCase().replace(/[\s_\-]+/g, " ").trim();
  if (!spaced) return "";
  const canonical = spaced.replace(/ /g, "_");
  if (CANONICAL_COURIER_STATUSES.has(canonical)) return canonical; // already canonical
  // A return that reached the merchant is worded as "Delivered to …" — most
  // specific check first, before the plain DELIVERED prefix rule below.
  if (/DELIVERED TO (WAREHOUSE|VENDOR|SHIPPER|OFFICE|SHOP)/.test(spaced)) return "RETURN_TO_SHIPPER";
  if (/^DELIVERED\b/.test(spaced)) return "DELIVERED";
  if (/OUT FOR DELIVERY/.test(spaced)) return "OUT_FOR_DELIVERY";
  if (/ASSIGNED TO COURIER/.test(spaced)) return "ASSIGNED_TO_COURIER";
  if (/\bRTO\b/.test(spaced) || /RETURN(ED)? TO (SHIPPER|ORIGIN|SENDER)/.test(spaced)) return "RETURN_TO_SHIPPER";
  if (/^RETURNED\b/.test(spaced)) return "RETURNED";
  if (/PICKED (UP|IN)/.test(spaced)) return "PICKED_UP"; // "Picked up" / Leopards "Shipment picked in {city}"
  if (/IN TRANSIT|DISPATCHED|^ARRIVED|^RECEIVED|^SORTED|DEPARTED/.test(spaced)) return "IN_TRANSIT";
  if (/^BOOKED$|^PICKUP REQUEST/.test(spaced)) return "BOOKED";
  if (/^CANCEL/.test(spaced)) return "CANCELLED";
  return canonical; // unknown (e.g. Leopards "PENDING" failed attempt) → unchanged, stays unmapped
}

const TRUEISH = new Set(["1", "true", "success", "ok", "yes"]);

function isTrueish(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === "string") return TRUEISH.has(value.toLowerCase().trim());
  return false;
}

const PAYLOAD_PATHS: string[][] = [
  ["data"], ["result"], ["payload"], ["response"], ["tracking"],
  ["data", "data"], ["data", "result"], ["data", "payload"], ["result", "data"], ["payload", "data"],
];

/** Dig into common response wrappers to find the object that actually holds tracking data. */
function normalizeTrackingPayload(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object") return {};
  const root = data as Record<string, unknown>;
  const candidates: Record<string, unknown>[] = [root];
  for (const path of PAYLOAD_PATHS) {
    let cur: unknown = root;
    for (const seg of path) {
      if (!cur || typeof cur !== "object" || !(seg in (cur as Record<string, unknown>))) { cur = null; break; }
      cur = (cur as Record<string, unknown>)[seg];
    }
    if (cur && typeof cur === "object") candidates.push(cur as Record<string, unknown>);
  }
  for (const c of candidates) if (hasTrackingPayload(c)) return c;
  return root;
}

const TRACKING_DIRECT_KEYS = ["order_status", "orderStatus", "latest_status", "latestStatus", "status_text", "live_courier_status", "tracking_number", "tracking_history", "history"];
const EVENT_TIME_KEYS = ["time", "datetime", "date", "created_at", "scanned_at", "timestamp", "updated_at"];
const EVENT_KEYS = ["status", "order_status", "shipment_status", "activity_status", "title", "description", "state"];

function hasTrackingPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) === false && Object.keys(payload).length === 0) {
    return false;
  }
  const p = payload as Record<string, unknown>;
  for (const key of TRACKING_DIRECT_KEYS) if (key in p) return true;
  if (typeof p.status === "string") {
    const s = p.status.toLowerCase().trim();
    if (s && !TRUEISH.has(s) && !["error", "failed", "false", "0"].includes(s)) return true;
  }
  const eventGroups: unknown[] = [];
  if (Array.isArray(payload)) eventGroups.push(payload);
  for (const key of ["tracking_history", "history", "events", "activities", "tracking"]) {
    if (Array.isArray(p[key])) eventGroups.push(p[key]);
  }
  for (const events of eventGroups) {
    if (!Array.isArray(events)) continue;
    for (const event of events.slice(0, 3)) {
      if (!event || typeof event !== "object") continue;
      const e = event as Record<string, unknown>;
      for (const key of EVENT_KEYS) if (key in e && String(e[key] ?? "").trim()) return true;
    }
  }
  return false;
}

interface RawEvent { status: string; description: string | null; location: string | null; scanned_at: string }

function extractHistory(payload: Record<string, unknown>): RawEvent[] {
  const groups: unknown[] = [];
  for (const key of ["tracking_history", "history", "events", "activities", "tracking"]) {
    if (Array.isArray(payload[key])) groups.push(payload[key]);
  }
  if (Array.isArray(payload) || Array.isArray((payload as { data?: unknown }).data)) {
    const arr = Array.isArray(payload) ? payload : (payload as { data: unknown[] }).data;
    if (arr.every((x) => x && typeof x === "object")) groups.push(arr);
  }
  const events: RawEvent[] = [];
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const raw of group) {
      if (!raw || typeof raw !== "object") continue;
      const e = raw as Record<string, unknown>;
      const status = String(e.status ?? e.order_status ?? e.shipment_status ?? e.activity_status ?? e.title ?? e.state ?? "").trim();
      if (!status) continue;
      const description = [e.description, e.remarks, e.detail, e.message].find((d) => d && String(d).trim());
      const location = [e.location, e.city, e.scanned_location].find((l) => l && String(l).trim());
      const time = [e.time, e.datetime, e.date, e.created_at, e.scanned_at, e.timestamp, e.updated_at].find((t) => t && String(t).trim());
      const scanned = time ? new Date(String(time)).toISOString() : new Date().toISOString();
      events.push({
        status: status.toUpperCase(),
        description: description ? String(description) : null,
        location: location ? String(location) : null,
        scanned_at: Number.isNaN(new Date(scanned).getTime()) ? new Date().toISOString() : scanned,
      });
    }
  }
  return events;
}

export interface TrackingStatusFields {
  /**
   * Authoritative Flaship shipment status, uppercased — the shipment-level
   * canonical field on the tracking response. Sources, in precedence order:
   * `order_status` / `orderStatus` / `latest_status` / `latestStatus` (fields
   * the app has always treated as the shipment state, also emitted by the
   * built-in simulator), then the top-level `status` field verified in
   * production 2026-10 ("status": "OUT_FOR_DELIVERY" while live_courier_status
   * still reads "Assigned to courier in SARGODHA"). Null when the response
   * carries none.
   */
  shipmentStatus: string | null;
  /**
   * Raw courier scan text (`live_courier_status`, e.g. "Assigned to courier in
   * SARGODHA") with its ORIGINAL casing preserved for display and diagnostics.
   * Never authoritative on its own: a courier scan alone must never fabricate
   * OUT_FOR_DELIVERY (Leopards words its pre-OFD rider assignment this way).
   */
  courierStatus: string | null;
}

/**
 * Canonical status-normalization layer (typed) — separates the three classes
 * of status data a Flaship tracking response can carry:
 *
 *   1. Authoritative shipment status  → `shipmentStatus` (see interface).
 *   2. Raw courier status             → `courierStatus` (verbatim scan text).
 *   3. Tracking-history events        → raw per-scan text + timestamps,
 *      extracted separately by extractHistory() and persisted as checkpoints.
 *
 * Precedence fixed here (2026-10 OFD sync bug): the authoritative top-level
 * `status` is consulted BEFORE `live_courier_status`. The previous ?? chain
 * let the raw courier scan shadow the authoritative shipment status, so a
 * verified "OUT_FOR_DELIVERY" response was parsed as "ASSIGNED TO COURIER …",
 * the order stayed IN_TRANSIT and the customer Out-for-Delivery WhatsApp never
 * fired. `status` is accepted as authoritative only when it normalizes to a
 * RECOGNIZED canonical key — success flags ("success"/"ok"/"true"/…) and
 * unrecognized text can never hijack the state, and an unknown value is never
 * silently classified as DELIVERED, CANCELLED or OUT_FOR_DELIVERY.
 */
export function extractTrackingStatusFields(payload: Record<string, unknown>): TrackingStatusFields {
  const directShipment = payload.order_status ?? payload.orderStatus ?? payload.latest_status ?? payload.latestStatus;
  const directUpper = directShipment && String(directShipment).trim() ? String(directShipment).trim().toUpperCase() : null;

  let topLevelUpper: string | null = null;
  if (!directUpper && typeof payload.status === "string") {
    const s = payload.status.trim();
    const lower = s.toLowerCase();
    // Same success-flag guard extractLatestStatus has always applied to
    // `status`, plus the recognized-canonical gate: an explicit canonical
    // shipment status is authoritative; anything else defers to the raw
    // courier scan (the previous behavior for unrecognized top-level text).
    // The CANONICAL underscore form is returned so casing/spaces/hyphens are
    // normalized consistently; the original raw text stays available in
    // checkpoints/logs and in the courierStatus field.
    if (s && !TRUEISH.has(lower) && !["error", "failed"].includes(lower)) {
      const canonical = normalizeCourierStatus(s);
      if (CANONICAL_COURIER_STATUSES.has(canonical)) topLevelUpper = canonical;
    }
  }

  const rawCourier = payload.live_courier_status;
  const courierStatus = rawCourier && String(rawCourier).trim() ? String(rawCourier).trim() : null;

  return { shipmentStatus: directUpper ?? topLevelUpper, courierStatus };
}

function extractLatestStatus(payload: Record<string, unknown>): string | null {
  // Precedence: authoritative Flaship shipment status first, raw courier scan
  // second, newest history event last (the original fallback, unchanged).
  const { shipmentStatus, courierStatus } = extractTrackingStatusFields(payload);
  if (shipmentStatus) return shipmentStatus;
  if (courierStatus) return courierStatus.toUpperCase();
  const history = extractHistory(payload);
  if (history.length) {
    // newest first when timestamps allow
    const sorted = [...history].sort((a, b) => new Date(b.scanned_at).getTime() - new Date(a.scanned_at).getTime());
    return sorted[0].status;
  }
  return null;
}

/** Sync tracking for an order; persists checkpoints and applies status changes. */
export async function syncOrderTracking(session: Actor | null, orderId: string): Promise<{ applied: boolean; message: string }> {
  const order = await store.get<Order>("orders", orderId);
  if (!order) throw new FlashipError("Order not found.");
  if (!order.tracking_number) throw new FlashipError("This order has no tracking number yet. Book it with Flaship first.");

  const cfg = await getFlashipConfig();
  let raw: unknown;

  if (cfg.mode === "live") {
    raw = await liveRequest<unknown>(cfg, cfg.endpoints.tracking.replace("{cn}", encodeURIComponent(order.tracking_number)), { orderId });
  } else {
    raw = (await simulateTracking(order.tracking_number, order)) as unknown;
  }

  const payload = normalizeTrackingPayload(raw);
  // Typed normalization: authoritative shipment status vs raw courier scan vs
  // history events. `latestStatus` is the EFFECTIVE status (authoritative
  // first — the verified production response carries status OUT_FOR_DELIVERY
  // while live_courier_status still reads "Assigned to courier in …"); the
  // verbatim courier scan is kept separately for checkpoints/diagnostics.
  const statusFields = extractTrackingStatusFields(payload);
  const latestStatus = extractLatestStatus(payload);
  const history = extractHistory(payload);
  const checkpoints = history.length
    ? history
    : latestStatus
      ? [{ status: latestStatus, description: null, location: null, scanned_at: new Date().toISOString() }]
      : [];

  const shipment = await store.first("shipments", { order_id: orderId });

  // persist checkpoints (skip ones we already have by status+date)
  const existing = await store.list<{ status: string; scanned_at: string }>("shipment_tracking", {
    filters: { order_id: orderId },
  });
  let added = 0;
  for (const cp of checkpoints) {
    const scanned = cp.scanned_at ?? new Date().toISOString();
    const dup = existing.rows.some((e) => e.status === cp.status && e.scanned_at.slice(0, 10) === scanned.slice(0, 10));
    if (dup) continue;
    await store.insert("shipment_tracking", {
      order_id: orderId,
      shipment_id: shipment?.id ?? null,
      status: cp.status,
      description: cp.description ?? null,
      location: cp.location ?? null,
      scanned_at: scanned,
    });
    added++;
  }

  // Free-text courier statuses (Leopards "ASSIGNED TO COURIER IN SARGODHA" etc.)
  // are normalized to canonical keys before the STATUS_MAP lookup — exact-match
  // only left orders stuck at BOOKED and made later syncs report "up to date".
  // The effective status (authoritative Flaship shipment status when present,
  // raw courier scan otherwise) drives the mapping and the triggers below.
  const statusKey = latestStatus ? normalizeCourierStatus(latestStatus) : "";
  const mapped = statusKey ? STATUS_MAP[statusKey] : undefined;
  await store.update("orders", orderId, { last_synced_at: new Date().toISOString() });
  if (shipment) {
    await store.update("shipments", shipment.id, {
      // Raw courier scan verbatim when the response carries one (display and
      // troubleshooting fidelity); otherwise the effective authoritative
      // status. Never a fabricated value.
      shipment_status: statusFields.courierStatus ?? latestStatus ?? "UNKNOWN",
      last_synced_at: new Date().toISOString(),
    });
  }

  // ---- WhatsApp notification fan-out (courier-level events; never throws) ----
  // OUT_FOR_DELIVERY and SHIPPER ADVISE never change the RoyalCarePK order
  // status (they are courier-side states), so they are detected here on the
  // NORMALIZED courier key — Leopards' free-text spellings ("OUT FOR
  // DELIVERY", "SHIPPER ADVISE …", "DELIVERED TO WAREHOUSE") now match exactly
  // like the canonical underscore forms always did. Idempotency keys make
  // repeated syncs safe.
  if (statusKey === "OUT_FOR_DELIVERY") {
    await enqueueWhatsAppOrderEvent({ orderId, type: "OUT_FOR_DELIVERY" });
  }
  if (statusKey.includes("SHIPPER_ADVISE") || statusKey.includes("RETURN_TO_SHIPPER")) {
    await enqueueWhatsAppOrderEvent({ orderId, type: "SHIPPER_ADVISE" });
  }

  if (mapped?.status && order.status !== mapped.status) {
    // Out-of-order protection: a stale or out-of-order tracking response must
    // never REGRESS a newer valid order status (e.g. Flaship still reporting
    // IN_TRANSIT after the order was delivered/returned). The shared
    // transition map is the single source of truth — a disallowed
    // auto-transition is reported clearly instead of applied. Previously this
    // threw AFTER checkpoints/notifications had already been written, failing
    // the whole sync with "Cannot change status from …".
    if (!canTransition(order.status, mapped.status)) {
      console.warn(
        `[flaship] tracking sync kept order ${order.order_number} at ${order.status} — Flaship reports ${mapped.label} (backward transition not allowed)`
      );
      return {
        applied: false,
        message: `Flaship reports "${mapped.label}", but the order is already ${order.status} — keeping the newer order status.`,
      };
    }
    await changeOrderStatus(session ?? { userId: "system" }, orderId, mapped.status, `Auto-synced from Flaship: ${mapped.label}`);
    return { applied: true, message: `Status updated to ${mapped.label}.` };
  }
  return { applied: false, message: added > 0 ? `${added} new tracking checkpoint(s) saved. No status change.` : "Tracking is up to date." };
}
