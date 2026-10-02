/**
 * READ-ONLY investigation of the failed Flaship booking
 * (order: Shahzad Anjum / Okara / PKR 1,500 / PENDING / not booked).
 *
 * Guarantees:
 *  - GET requests ONLY (PostgREST reads + one 42703 reproduction query).
 *  - NO writes, NO deletes, NO migrations, NO Flaship API calls.
 *  - Secrets (service key / API key) loaded from .env.local, NEVER printed.
 *  - Stored flaship_logs payloads were redacted at write time; re-redacted
 *    here anyway before printing. Customer phone shown partially (owner data).
 */
import fs from "fs";
import path from "path";

const root = "/home/z/my-project";
const envRaw = fs.readFileSync(path.join(root, ".env.local"), "utf-8");
const env = {};
for (const line of envRaw.split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trim().startsWith("#")) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const URL_BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_BASE || !SERVICE) {
  console.error("FATAL: env missing (checked PRESENT only)");
  process.exit(1);
}
console.log(`env: SUPABASE_URL=PRESENT, SERVICE_KEY=PRESENT, host=${new URL(URL_BASE).host}`);

function redact(text) {
  return String(text)
    .replace(/(x-api-key"?\s*[:=]\s*"?)[^",}&]+/gi, "$1***REDACTED***")
    .replace(/(api[_-]?key"?\s*[:=]\s*"?)[^",}&]+/gi, "$1***REDACTED***")
    .replace(/(authorization"?\s*[:=]\s*"?)[^",}&]+/gi, "$1***REDACTED***")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer ***REDACTED***");
}

async function get(pathname, preferCount = false) {
  const headers = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };
  if (preferCount) headers.Prefer = "count=exact";
  const res = await fetch(`${URL_BASE}/rest/v1/${pathname}`, { headers });
  const range = res.headers.get("content-range");
  let body = null;
  const text = await res.text();
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, total: range ? Number(range.split("/")[1]) : null };
}

function maskPhone(p) {
  const s = String(p ?? "");
  return s.length > 4 ? `${s.slice(0, -4).replace(/[0-9]/g, "*")}${s.slice(-4)}` : "(short)";
}
function clip(v, n = 300) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s == null) return "null";
  return s.length > n ? `${redact(s.slice(0, n))}…(+${s.length - n} chars)` : redact(s);
}

// ---------------------------------------------------------------- 1. the order
console.log("\n=== 1. Locate the failed order ===");
const custProbe = await get(`customers?name=ilike.*Shahzad*&select=id,name,phone,city,address,email,status`);
console.log(`customers?name~Shahzad → ${custProbe.status}, rows=${Array.isArray(custProbe.body) ? custProbe.body.length : "?"}`);
const customer = Array.isArray(custProbe.body) ? custProbe.body[0] : null;
if (customer) {
  console.log(`  customer: id=${customer.id} name=${customer.name} city=${customer.city ?? "null"} status=${customer.status}`);
  console.log(`  phone(stored)=${maskPhone(customer.phone)} address=${clip(customer.address ?? "null", 120)}`);
}

const cityMatch = `city.eq.${encodeURIComponent("Okara")}`;
const ordUrl = `orders?select=id,order_number,customer_id,status,subtotal,discount,total,cod_amount,city,delivery_address,notes,booking_status,booking_error,flaship_booking_id,tracking_number,flaship_courier_name,pickup_location_name,booked_at,created_at,updated_at&${cityMatch}&cod_amount=eq.1500&order=created_at.desc&limit=5`;
const ordProbe = await get(ordUrl);
const orders = Array.isArray(ordProbe.body) ? ordProbe.body : [];
console.log(`orders?city=Okara&cod_amount=1500 → ${ordProbe.status}, rows=${orders.length}`);
const order = orders.find((o) => customer && o.customer_id === customer.id) ?? orders[0] ?? null;
if (!order) {
  console.log("  !! no matching order found — dumping latest Okara/1500 rows:");
  for (const o of orders) console.log(`   - ${o.order_number} cust=${o.customer_id} status=${o.status} bs=${o.booking_status}`);
} else {
  console.log(`  order: ${order.order_number} id=${order.id}`);
  console.log(`    status=${order.status} booking_status=${order.booking_status} booking_error=${JSON.stringify(order.booking_error)}`);
  console.log(`    tracking_number=${JSON.stringify(order.tracking_number)} flaship_booking_id=${JSON.stringify(order.flaship_booking_id)}`);
  console.log(`    courier=${JSON.stringify(order.flaship_courier_name)} pickup_location_name=${JSON.stringify(order.pickup_location_name)}`);
  console.log(`    city=${JSON.stringify(order.city)} cod_amount=${order.cod_amount} total=${order.total}`);
  console.log(`    delivery_address=${clip(order.delivery_address, 150)}`);
  console.log(`    notes=${JSON.stringify(order.notes)}`);
  console.log(`    created_at=${order.created_at} updated_at=${order.updated_at}`);
}

// ------------------------------------------------- 2. order_items + 42703 repro
if (order) {
  console.log("\n=== 2. order_items — reproduce the EXACT query bookOrderWithFlaship issues ===");
  // service.ts:497 → store.list("order_items", { filters:{order_id}, perPage:50 })
  // supabase.ts:68 → no orderBy ⇒ order=created_at.desc  (order_items has NO created_at)
  const repro = await get(`order_items?order_id=eq.${order.id}&order=created_at.desc&limit=50`);
  console.log(`  REPRO order=created_at.desc → HTTP ${repro.status} code=${repro.body?.code ?? "-"} message=${clip(repro.body?.message, 160)}`);
  const fixed = await get(`order_items?order_id=eq.${order.id}&order=id.asc&limit=50`);
  const items = Array.isArray(fixed.body) ? fixed.body : [];
  console.log(`  FIXED order=id.asc        → HTTP ${fixed.status}, rows=${items.length}`);
  for (const it of items) console.log(`    - ${it.product_name} x${it.quantity} unit=${it.unit_price} line_total=${it.line_total}`);
}

// --------------------------------------------------- 3. booking side effects?
console.log("\n=== 3. Side-effect audit: did ANY booking write or Flaship call happen? ===");
const logCount = await get("flaship_logs?select=id,endpoint&limit=1", true);
console.log(`  flaship_logs total rows: ${logCount.total ?? "?"} (probe status ${logCount.status})`);
const logBookings = await get(`flaship_logs?endpoint=like.*bookings*&select=id,order_id,endpoint,method,status_code,success,duration_ms,error,created_at&order=created_at.desc&limit=10`);
console.log(`  flaship_logs endpoint~bookings → ${logBookings.status}, rows=${Array.isArray(logBookings.body) ? logBookings.body.length : "?"}`);
for (const l of Array.isArray(logBookings.body) ? logBookings.body : []) {
  console.log(`    - ${l.created_at} ${l.method} ${l.endpoint} http=${l.status_code} success=${l.success} order=${l.order_id ?? "null"} err=${clip(l.error, 120)}`);
}
if (order) {
  const logForOrder = await get(`flaship_logs?order_id=eq.${order.id}&select=id,endpoint,method,status_code,success,request_redacted,response,error,created_at&order=created_at.desc&limit=10`);
  const rows = Array.isArray(logForOrder.body) ? logForOrder.body : [];
  console.log(`  flaship_logs for this order → ${logForOrder.status}, rows=${rows.length}`);
  for (const l of rows) {
    console.log(`    - ${l.created_at} ${l.method} ${l.endpoint} http=${l.status_code} success=${l.success} err=${clip(l.error, 120)}`);
    if (l.request_redacted) console.log(`      request_redacted: ${clip(l.request_redacted, 400)}`);
    if (l.response) console.log(`      response: ${clip(l.response, 400)}`);
  }
}
const notif = await get(`notifications?title=eq.${encodeURIComponent("Flaship booking failed")}&select=id,title,message,created_at&order=created_at.desc&limit=5`);
console.log(`  notifications 'Flaship booking failed' → ${notif.status}, rows=${Array.isArray(notif.body) ? notif.body.length : "?"}`);
for (const n of Array.isArray(notif.body) ? notif.body : []) console.log(`    - ${n.created_at} ${clip(n.message, 200)}`);
const audit = await get(`audit_logs?action=in.(${encodeURIComponent("flaship.booking_failed,flaship.booking_created")})&select=id,action,entity,entity_id,new_data,user_name,created_at&order=created_at.desc&limit=10`);
console.log(`  audit_logs flaship.booking_* → ${audit.status}, rows=${Array.isArray(audit.body) ? audit.body.length : "?"}`);
for (const a of Array.isArray(audit.body) ? audit.body : []) {
  console.log(`    - ${a.created_at} ${a.action} entity=${a.entity}/${a.entity_id} by=${a.user_name ?? "?"} new_data=${clip(a.new_data, 200)}`);
}

// ---------------------------------------------------------------- 4. catalog
console.log("\n=== 4. Synced Flaship catalog (does the booking data exist?) ===");
for (const t of ["flaship_couriers", "flaship_cities", "flaship_pickups"]) {
  const c = await get(`${t}?select=id&limit=1`, true);
  console.log(`  ${t}: ${c.total ?? "?"} row(s) (probe ${c.status})`);
}
const okara = await get(`flaship_cities?name=ilike.*okara*&select=city_id,name,province,active,synced_at`);
console.log(`  cities matching 'okara' → ${okara.status}, rows=${Array.isArray(okara.body) ? okara.body.length : "?"}`);
for (const c of Array.isArray(okara.body) ? okara.body : []) console.log(`    - city_id=${JSON.stringify(c.city_id)} name=${c.name} province=${c.province} active=${c.active} synced=${c.synced_at}`);
const couriers = await get(`flaship_couriers?select=courier_id,name,active&order=name.asc&limit=30`);
console.log(`  couriers → ${couriers.status}, rows=${Array.isArray(couriers.body) ? couriers.body.length : "?"}`);
for (const c of Array.isArray(couriers.body) ? couriers.body : []) console.log(`    - courier_id=${JSON.stringify(c.courier_id)} name=${c.name} active=${c.active}`);
const pickups = await get(`flaship_pickups?select=pickup_id,name,city,address,active&limit=10`);
console.log(`  pickups → ${pickups.status}, rows=${Array.isArray(pickups.body) ? pickups.body.length : "?"}`);
for (const p of Array.isArray(pickups.body) ? pickups.body : []) console.log(`    - pickup_id=${JSON.stringify(p.pickup_id)} name=${p.name} city=${p.city} active=${p.active}`);

// ------------------------------------------------------- 5. flaship settings
console.log("\n=== 5. Flaship settings (NON-SECRET fields only) ===");
const sres = await get(`settings?key=eq.flaship&select=value`);
const val = Array.isArray(sres.body) && sres.body[0]?.value ? sres.body[0].value : {};
const safe = { ...val };
delete safe.api_key_enc;   // never printed
delete safe.api_key_masked; // never printed
console.log(`  mode=${JSON.stringify(safe.mode)} base_url=${JSON.stringify(safe.base_url)}`);
console.log(`  default_courier=${JSON.stringify(safe.default_courier)} default_service_type=${JSON.stringify(safe.default_service_type)} default_pickup=${JSON.stringify(safe.default_pickup)}`);
console.log(`  default_weight=${JSON.stringify(safe.default_weight)} timeout_ms=${JSON.stringify(safe.timeout_ms)} auto_sync_tracking=${JSON.stringify(safe.auto_sync_tracking)}`);
console.log(`  endpoints=${JSON.stringify(safe.endpoints ?? null)}`);
console.log(`  api_key_enc PRESENT=${typeof val.api_key_enc === "string" && val.api_key_enc.length > 0} (value never shown)`);

console.log("\nDONE — read-only probes complete (GET only, no writes, no Flaship calls).");
