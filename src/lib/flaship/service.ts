import "server-only";
import { store, IS_DEMO_MODE } from "@/lib/store";
import type { FlashipCourier, FlashipCity, FlashipPickup, Order, OrderItem } from "@/lib/types";
import { decryptSecret } from "@/lib/crypto/secret-box";
import { logAudit, type Actor } from "@/lib/services/audit";
import { notifyAdmins } from "@/lib/services/notifications";
import { changeOrderStatus } from "@/lib/services/orders";

export class FlashipError extends Error {}

/**
 * Flaship Integration API client — server-side only.
 *
 * Technical reference: official Flaship WooCommerce plugin (Integration API v2):
 *   GET  {base}/catalog/                       → couriers, pickups, operational cities
 *   POST {base}/bookings/                      → create booking (returns tracking_number)
 *   GET  {base}/orders/{tracking_number}/tracking/  → tracking + history
 *   Auth: header `X-API-KEY: <integration token>`
 *   Base URL must point at the Integration API root (…/api/integration/).
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
  return {
    ...DEFAULT_CONFIG,
    ...v,
    endpoints: { ...DEFAULT_CONFIG.endpoints, ...(v.endpoints || {}) },
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
  const cn = `CN${Math.floor(1000000000 + Math.random() * 9000000000)}`;
  return simulate({
    success: true,
    id: `FLB${Math.floor(10000000 + Math.random() * 89999999)}`,
    tracking_number: cn,
    courier_code: payload.courier_code,
    external_ref_no: payload.external_ref_no,
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
      const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
      const apiMsg = obj
        ? (["message", "detail", "error"] as const).map((k) => obj[k]).find((x) => x && String(x).trim())
        : null;
      throw new FlashipError(apiMsg ? String(apiMsg) : `Flaship API error (HTTP ${res.status})`);
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

interface RawCatalog {
  couriers: Record<string, unknown>[];
  pickups: Record<string, unknown>[];
  cities: Record<string, unknown>[];
}

function unwrap(payload: unknown): Record<string, unknown> {
  // Response may be the body itself, { data: {...} }, { result: {...} } etc.
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

function extractCityName(city: unknown): string {
  if (typeof city === "string") return city.trim();
  if (city && typeof city === "object") {
    const o = city as Record<string, unknown>;
    const name = o.name ?? o.cityname ?? o.city_name ?? o.City ?? o.terminal_name;
    return name ? String(name).trim() : "";
  }
  return "";
}

/** Normalize the /catalog/ response into couriers / pickups / unique cities. */
function normalizeCatalog(payload: unknown): RawCatalog {
  const body = unwrap(payload);
  const dataObj = (body.data && typeof body.data === "object" ? body.data : {}) as Record<string, unknown>;
  const couriers: Record<string, unknown>[] = [];
  const couriersRaw = body.couriers ?? dataObj.couriers;
  if (Array.isArray(couriersRaw)) {
    for (const c of couriersRaw) {
      if (!c || typeof c !== "object") continue;
      const o = c as Record<string, unknown>;
      const code = String(o.code ?? o.courier_code ?? o.id ?? "").toLowerCase().trim();
      const label = String(o.display_name ?? o.name ?? code).trim();
      if (code) couriers.push({ courier_id: code, name: label || code, code });
    }
  }

  const pickups: Record<string, unknown>[] = [];
  const pickupsRaw = body.pickups ?? body.pickup_locations ?? body.pickup_points ?? dataObj.pickups;
  if (Array.isArray(pickupsRaw)) {
    for (const p of pickupsRaw) {
      if (!p || typeof p !== "object") continue;
      const o = p as Record<string, unknown>;
      const pid = String(o.id ?? o.pickup_id ?? "");
      const name = String(o.name ?? o.title ?? "");
      if (pid || name) pickups.push({ pickup_id: pid, name: name || pid, address: o.address ?? null, city: o.city ?? null, contact: o.contact ?? o.phone ?? null });
    }
  }

  const cityMap = new Map<string, Record<string, unknown>>();
  const citiesRaw = body.operational_cities ?? body.cities ?? dataObj.operational_cities;
  if (Array.isArray(citiesRaw)) {
    for (const c of citiesRaw) {
      const name = extractCityName(c);
      if (name) cityMap.set(name.toLowerCase(), { city_id: name.toLowerCase(), name, province: null });
    }
  } else if (citiesRaw && typeof citiesRaw === "object") {
    // Integration API keys operational_cities by lowercase courier_code
    for (const list of Object.values(citiesRaw as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      for (const c of list) {
        const name = extractCityName(c);
        if (name) cityMap.set(name.toLowerCase(), { city_id: name.toLowerCase(), name, province: null });
      }
    }
  }

  return { couriers, pickups, cities: [...cityMap.values()] };
}

/** Fetch + persist the catalog (couriers / cities / pickup locations). */
export async function syncCatalog(type: "couriers" | "cities" | "pickups" | "all"): Promise<{ couriers: number; cities: number; pickups: number }> {
  const cfg = await getFlashipConfig();
  let catalog: RawCatalog;

  if (cfg.mode === "live") {
    const res = await liveRequest<unknown>(cfg, cfg.endpoints.catalog);
    catalog = normalizeCatalog(res);
    if (!catalog.couriers.length && !catalog.cities.length && !catalog.pickups.length) {
      throw new FlashipError("Flaship catalog response was empty. Verify the API key and base URL.");
    }
  } else {
    const [couriers, cities, pickups] = await Promise.all([
      simulateCatalog("couriers") as Promise<Record<string, unknown>[]>,
      simulateCatalog("cities") as Promise<Record<string, unknown>[]>,
      simulateCatalog("pickups") as Promise<Record<string, unknown>[]>,
    ]);
    catalog = { couriers, cities: cities as unknown as RawCatalog["cities"], pickups };
  }

  const now = new Date().toISOString();
  const counts = { couriers: 0, cities: 0, pickups: 0 };

  // The catalog is persisted with bulk upserts keyed on each table's UNIQUE
  // business column (courier_id / city_id / pickup_id). The previous
  // read-then-insert/update loop could only compare against the first page of
  // existing rows (PostgREST caps unpaginated reads at ~1,000), so catalogs
  // larger than the cap raised duplicate-key errors (e.g. 2,700+ cities).
  // Conflict resolution now happens in the database on the constraint itself:
  // safe at any size and idempotent across repeat refreshes.
  if (type === "couriers" || type === "all") {
    const byId = new Map<string, Record<string, unknown>>();
    for (const item of catalog.couriers) {
      const cid = String(item.courier_id ?? item.id ?? "");
      const name = String(item.name ?? item.courier_name ?? "");
      if (!cid || !name) continue;
      byId.set(cid, { courier_id: cid, name, active: true, synced_at: now });
    }
    if (byId.size) await store.upsertMany("flaship_couriers", [...byId.values()], ["courier_id"]);
    counts.couriers = byId.size;
  }
  if (type === "cities" || type === "all") {
    const byId = new Map<string, Record<string, unknown>>();
    for (const item of catalog.cities) {
      const name = String(item.name ?? item.city ?? "").trim();
      if (!name) continue;
      const cid = String(item.city_id ?? item.id ?? name.toLowerCase());
      byId.set(cid, { city_id: cid, name, province: item.province ?? null, active: true, synced_at: now });
    }
    if (byId.size) await store.upsertMany("flaship_cities", [...byId.values()], ["city_id"]);
    counts.cities = byId.size;
  }
  if (type === "pickups" || type === "all") {
    const byId = new Map<string, Record<string, unknown>>();
    for (const item of catalog.pickups) {
      const pid = String(item.pickup_id ?? item.id ?? "");
      const name = String(item.name ?? "");
      if (!pid || !name) continue;
      byId.set(pid, { pickup_id: pid, name, address: item.address ? String(item.address) : null, city: item.city ? String(item.city) : null, contact: item.contact ? String(item.contact) : null, active: true, synced_at: now });
    }
    if (byId.size) await store.upsertMany("flaship_pickups", [...byId.values()], ["pickup_id"]);
    counts.pickups = byId.size;
  }
  return counts;
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
    const catalog = normalizeCatalog(res);
    return {
      ok: true,
      message: `Connected. Catalog loaded: ${catalog.couriers.length} courier(s), ${catalog.cities.length} cit(ies), ${catalog.pickups.length} pickup location(s).`,
      mode: "live",
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Connection failed.", mode: "live" };
  }
}

// ---------------- Booking (POST /bookings/) ----------------

export interface BookingResult {
  bookingId: string;
  trackingNumber: string;
  courierName: string;
}

/** Normalize Pakistani phone formats: +92 / 92 prefixes → leading 0 (per Flaship plugin). */
export function normalizePkPhone(phone: string): string {
  const cleaned = String(phone ?? "").replace(/[^0-9+]/g, "");
  if (cleaned.startsWith("+92")) return `0${cleaned.slice(3)}`;
  if (cleaned.startsWith("92")) return `0${cleaned.slice(2)}`;
  return cleaned;
}

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

  const cfg = await getFlashipConfig();
  const customer = await store.get<{ name: string; phone: string; email: string | null }>("customers", order.customer_id);
  const { rows: items } = await store.list<OrderItem>("order_items", { filters: { order_id: orderId }, perPage: 50 });
  const productName = items.length
    ? items.map((i) => `${i.product_name} (x${i.quantity})`).join(" -- ")
    : "Products";
  const pieces = Math.max(1, items.reduce((sum, i) => sum + (Number(i.quantity) || 1), 0));

  // mark as pending so concurrent clicks don't double-book
  await store.update("orders", orderId, { booking_status: "pending" });

  try {
    let result: Record<string, unknown>;

    // Payload structure mirrors the official Flaship Integration API (WooCommerce plugin reference)
    const payload: Record<string, unknown> = {
      pickup_id: Number.parseInt(String(opts?.pickup ?? cfg.default_pickup ?? "0"), 10) || 0,
      courier_code: String(opts?.courier ?? cfg.default_courier ?? "").toLowerCase(),
      service_type: String(opts?.serviceType ?? cfg.default_service_type ?? "overnight").toLowerCase(),
      product_name: productName,
      net_weight: String(cfg.default_weight ?? 0.5),
      pieces,
      cod_amount: order.cod_amount ?? 0,
      consignee_name: customer?.name ?? "Customer",
      consignee_phone_primary: normalizePkPhone(customer?.phone ?? ""),
      consignee_phone_secondary: "",
      consignee_address: order.delivery_address,
      consignee_city: order.city,
      special_instruction: order.notes ?? "",
      external_ref_no: order.order_number,
    };

    if (cfg.mode === "live") {
      result = await liveRequest<Record<string, unknown>>(cfg, cfg.endpoints.bookings, {
        method: "POST",
        body: payload,
        orderId,
      });
    } else {
      result = (await simulateBooking(payload)) as Record<string, unknown>;
    }

    // Response shape: { success, tracking_number, courier_code, id / external_ref_no, data? }
    const body = unwrap(result);
    const bookingId = String(body.id ?? body.booking_id ?? body.bookingId ?? body.external_ref_no ?? `FLB${Date.now()}`);
    const cn = String(body.tracking_number ?? body.trackingNumber ?? body.cn ?? "");
    const courierCode = String(body.courier_code ?? payload.courier_code ?? "").toLowerCase();
    const courierName = courierCode
      ? courierCode.toUpperCase()
      : String(body.courier_name ?? opts?.courier ?? cfg.default_courier ?? "Flaship");

    if (!cn) throw new FlashipError("Flaship did not return a tracking number (CN).");

    await store.update("orders", orderId, {
      booking_status: "booked",
      flaship_booking_id: bookingId,
      tracking_number: cn,
      flaship_courier_name: courierName,
      pickup_location_name: opts?.pickup ?? cfg.default_pickup ?? null,
      booking_error: null,
      booked_at: new Date().toISOString(),
    });

    await store.insert("shipments", {
      order_id: orderId,
      courier_name: courierName,
      tracking_number: cn,
      booking_id: bookingId,
      destination_city: order.city,
      pickup_location: payload.pickup_id ? String(payload.pickup_id) : null,
      shipment_status: "BOOKED",
      booked_at: new Date().toISOString(),
      last_synced_at: null,
    });

    if (order.status !== "BOOKED" && order.status !== "IN_TRANSIT") {
      await changeOrderStatus(session ?? { userId: "system" }, orderId, "BOOKED", `Booked with ${courierName}`);
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
  DELIVERED: { status: "DELIVERED", label: "Delivered" },
  RETURNED: { status: "RETURNED", label: "Returned" },
  RTO: { status: "RETURNED", label: "Return to origin" },
  RTO_INTRANSIT: { status: "RETURNED", label: "Return to origin (in transit)" },
  RETURN_TO_SHIPPER: { status: "RETURNED", label: "Return to shipper" },
  CANCELLED: { label: "Cancelled" },
};

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

function extractLatestStatus(payload: Record<string, unknown>): string | null {
  const direct = payload.order_status ?? payload.orderStatus ?? payload.latest_status ?? payload.latestStatus ?? payload.live_courier_status;
  if (direct && String(direct).trim()) return String(direct).trim().toUpperCase();
  if (typeof payload.status === "string" && !TRUEISH.has(payload.status.toLowerCase().trim()) && !["error", "failed"].includes(payload.status.toLowerCase().trim())) {
    return payload.status.trim().toUpperCase();
  }
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
  const courierStatus = extractLatestStatus(payload);
  const history = extractHistory(payload);
  const checkpoints = history.length
    ? history
    : courierStatus
      ? [{ status: courierStatus, description: null, location: null, scanned_at: new Date().toISOString() }]
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

  const mapped = courierStatus ? STATUS_MAP[courierStatus.toUpperCase()] : undefined;
  await store.update("orders", orderId, { last_synced_at: new Date().toISOString() });
  if (shipment) {
    await store.update("shipments", shipment.id, {
      shipment_status: courierStatus ?? "UNKNOWN",
      last_synced_at: new Date().toISOString(),
    });
  }

  if (mapped?.status && order.status !== mapped.status) {
    await changeOrderStatus(session ?? { userId: "system" }, orderId, mapped.status, `Auto-synced from Flaship: ${mapped.label}`);
    return { applied: true, message: `Status updated to ${mapped.label}.` };
  }
  return { applied: false, message: added > 0 ? `${added} new tracking checkpoint(s) saved. No status change.` : "Tracking is up to date." };
}
