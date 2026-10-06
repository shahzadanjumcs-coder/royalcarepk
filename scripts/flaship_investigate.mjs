/**
 * READ-ONLY Flaship booking investigation — Task 37-flaship-400
 *
 * Queries the production Supabase (credentials from whatsapp-bot/.env, NEVER printed)
 * to answer:
 *   1. The EXACT Flaship HTTP 400 response body (stored in flaship_logs.response)
 *   2. The order + customer data used to build the booking payload
 *   3. The stored Flaship settings (structure only — api_key_enc presence as boolean, never its value)
 *   4. Catalog rows (couriers/pickups) whose values the booking UI auto-selects
 *
 * Guarantees:
 *   - SELECT-only requests (GET method to PostgREST)
 *   - All output passes through redact() before printing
 *   - No credential values are ever read into output variables
 */
import fs from "node:fs";

// ---------- load credentials (names only in output) ----------
const envPath = new URL("../whatsapp-bot/.env", import.meta.url);
if (!fs.existsSync(envPath)) {
  console.error("whatsapp-bot/.env not found — cannot query DB. Aborting (no fallback).");
  process.exit(1);
}
const env = {};
for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SB_URL = env.SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing. Aborting.");
  process.exit(1);
}
console.log("DB target host:", new URL(SB_URL).host); // host only, no key

const redact = (t) =>
  String(t)
    .replace(/(x-api-key"?\s*[:=]\s*"?)[^",}&]+/gi, "$1***REDACTED***")
    .replace(/(api[_-]?key"?\s*[:=]\s*"?)[^",}&]+/gi, "$1***REDACTED***")
    .replace(/(authorization"?\s*[:=]\s*"?)[^",}&]+/gi, "$1***REDACTED***")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer ***REDACTED***")
    .replace(/eyJ[A-Za-z0-9._-]{20,}/g, "***JWT-REDACTED***");

async function get(table, query) {
  const url = `${SB_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    console.error(`[query ${table}] HTTP ${res.status}:`, redact(await res.text()));
    return null;
  }
  return res.json();
}

const ORDER_ID = "d69034a3-adff-42b3-96c4-b4b862176792";

// ---------- 1. flaship_logs for this order (exact upstream response) ----------
console.log("\n===== 1. flaship_logs (order " + ORDER_ID + ") =====");
const logs = await get("flaship_logs",
  `order_id=eq.${ORDER_ID}&select=id,endpoint,method,status_code,success,duration_ms,error,request_redacted,response,created_at&order=created_at.desc&limit=20`);
if (logs === null) console.log("(query failed)");
else if (!logs.length) console.log("(no rows)");
else {
  console.log(`rows: ${logs.length}`);
  for (const l of logs) {
    console.log("---");
    console.log(`at ${l.created_at}  ${l.method} ${l.endpoint}  -> HTTP ${l.status_code}  success=${l.success}  ${l.duration_ms}ms`);
    console.log(`error: ${l.error}`);
    console.log(`request_redacted: ${l.request_redacted ?? "(null)"}`);
    console.log(`response (EXACT upstream body):`);
    console.log(redact(l.response ?? "(null)"));
  }
}

// ---------- 2. also check logs with NULL order_id near recent time (safety net) ----------
console.log("\n===== 2. recent flaship_logs (any order, last 15) =====");
const recent = await get("flaship_logs",
  `select=id,order_id,endpoint,method,status_code,success,error,created_at&order=created_at.desc&limit=15`);
if (recent === null) console.log("(query failed)");
else {
  for (const l of recent) {
    console.log(`${l.created_at}  ${l.method} ${l.endpoint}  HTTP ${l.status_code}  success=${l.success}  order=${l.order_id ?? "(null)"}  err=${redact(l.error ?? "")}`);
  }
}

// ---------- 3. the order ----------
console.log("\n===== 3. orders row =====");
const orders = await get("orders",
  `id=eq.${ORDER_ID}&select=order_number,status,approval_status,booking_status,booking_error,tracking_number,flaship_booking_id,flaship_courier_name,pickup_location_name,cod_amount,city,delivery_address,customer_id,notes,created_at`);
if (!orders || !orders.length) {
  console.log("(order not found)");
} else {
  const o = orders[0];
  console.log(redact(JSON.stringify(o, null, 2)));
  // ---------- 4. its customer ----------
  if (o.customer_id) {
    const cust = await get("customers", `id=eq.${o.customer_id}&select=name,phone,email,city,address`);
    console.log("\n===== 4. customer row =====");
    console.log(cust && cust.length ? redact(JSON.stringify(cust[0], null, 2)) : "(not found)");
  }
}

// ---------- 5. stored flaship settings (STRUCTURE ONLY — never key material) ----------
console.log("\n===== 5. settings row key='flaship' (structure only) =====");
const settings = await get("settings", `key=eq.flaship&select=id,key,value,updated_at`);
if (!settings || !settings.length) {
  console.log("(no row — defaults apply: base https://partners.flaship.pk/api/integration, service_type=overnight, weight=0.5, no default_courier, no default_pickup)");
} else {
  const v = settings[0].value ?? {};
  const safe = {
    row_updated_at: settings[0].updated_at,
    base_url: v.base_url ?? "(absent → default https://partners.flaship.pk/api/integration)",
    mode: v.mode ?? "(absent)",
    timeout_ms: v.timeout_ms ?? "(absent)",
    endpoints: v.endpoints ?? "(absent → defaults /catalog/ /bookings/ /orders/{cn}/tracking/)",
    default_courier: v.default_courier ?? "(absent)",
    default_pickup: v.default_pickup ?? "(absent)",
    default_service_type: v.default_service_type ?? "(absent → 'overnight')",
    default_weight: v.default_weight ?? "(absent → '0.5')",
    auto_sync_tracking: v.auto_sync_tracking ?? "(absent)",
    api_key_enc_present: typeof v.api_key_enc === "string" && v.api_key_enc.length > 0,
    api_key_enc_value: "/// NOT PRINTED ///",
    other_keys_in_value: Object.keys(v).filter((k) => !["api_key_enc"].includes(k)),
  };
  console.log(JSON.stringify(safe, null, 2));
}

// ---------- 6. catalog rows the booking UI auto-selects ----------
console.log("\n===== 6. flaship_couriers (first 10 by name) =====");
const couriers = await get("flaship_couriers", `select=courier_id,name,active,synced_at&order=name.asc&limit=10`);
console.log(couriers === null ? "(query failed)" : couriers.length ? JSON.stringify(couriers, null, 2) : "(EMPTY TABLE — UI would send no courier)");

console.log("\n===== 7. flaship_pickups (first 10) =====");
const pickups = await get("flaship_pickups", `select=pickup_id,name,city,active,synced_at&limit=10`);
console.log(pickups === null ? "(query failed)" : pickups.length ? JSON.stringify(pickups, null, 2) : "(EMPTY TABLE — UI would send no pickup → payload pickup_id=0)");

console.log("\n(done — read-only, nothing modified)");
