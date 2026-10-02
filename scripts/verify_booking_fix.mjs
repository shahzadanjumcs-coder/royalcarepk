/**
 * READ-ONLY verification of approved fixes A + B (booking crash + Book-button IDs).
 *
 * Guarantees:
 *  - GET requests ONLY against Supabase PostgREST. No writes, no migrations,
 *    NO Flaship API calls, NO booking attempt.
 *  - Secrets loaded from .env.local, NEVER printed.
 *
 * Proves:
 *  A. The exact queries SupabaseStore.list now issues after the DEFAULT_ORDER_COLUMN
 *     additions (order_items→id, shipment_tracking→scanned_at) return 200 on the live
 *     DB — booking path (service.ts:497), tracking path (service.ts:753), inventory
 *     paths (inventory.ts:129/151/173). The OLD failing query is re-reproduced for contrast.
 *  B. The catalog IDs the order-detail Book button now sends (courier_id/pickup_id)
 *     match what bookOrderWithFlaship expects: courier_id already lowercase
 *     (service.ts:512 toLowerCase is a no-op → exact catalog code), pickup_id
 *     numeric-parseable ≠ 0 (service.ts:511 parseInt).
 *  + Nothing was written: order still not_booked, flaship_logs count unchanged.
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
if (!URL_BASE || !SERVICE) { console.error("FATAL: env missing"); process.exit(1); }
console.log(`env: SUPABASE_URL=PRESENT, SERVICE_KEY=PRESENT, host=${new URL(URL_BASE).host}`);

let failed = 0;
function report(id, pass, detail) {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${id.padEnd(30)} ${detail}`);
}
async function get(pathname) {
  const res = await fetch(`${URL_BASE}/rest/v1/${pathname}`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  });
  let body = null;
  try { body = await res.json(); } catch { body = await res.text(); }
  return { status: res.status, body };
}

// ---- locate the failed order (read-only) ----
const ord = await get(`orders?select=id,order_number,booking_status,tracking_number,booking_error&city=eq.okara&cod_amount=eq.1500&limit=1`);
const order = Array.isArray(ord.body) ? ord.body[0] : null;
if (!order) { console.error("FATAL: order not found"); process.exit(1); }
console.log(`order: ${order.order_number} booking_status=${order.booking_status} tracking=${order.tracking_number}\n`);

// ---- A: queries as the FIXED code will issue them ----
const bookQ = await get(`order_items?order_id=eq.${order.id}&order=id.desc&limit=50`);
const bookRows = Array.isArray(bookQ.body) ? bookQ.body : [];
report("A1 book-path order_items", bookQ.status === 200 && bookRows.length >= 1,
  `GET order_items?order_id=…&order=id.desc&limit=50 → ${bookQ.status}, rows=${bookRows.length} (service.ts:497 post-fix)`);

const trackQ = await get(`shipment_tracking?order_id=eq.${order.id}&order=scanned_at.desc`);
report("A2 tracking-path shipment_tracking", trackQ.status === 200,
  `GET shipment_tracking?order_id=…&order=scanned_at.desc → ${trackQ.status}, rows=${Array.isArray(trackQ.body) ? trackQ.body.length : "?"} (service.ts:753 post-fix)`);

const invQ = await get(`order_items?order=id.desc&limit=1`);
report("A3 inventory-path order_items", invQ.status === 200,
  `GET order_items?order=id.desc&limit=1 → ${invQ.status} (inventory.ts:129/151/173 post-fix)`);

// ---- contrast: the OLD buggy query still reproduces 42703 (what A eliminates) ----
const oldQ = await get(`order_items?order_id=eq.${order.id}&order=created_at.desc&limit=50`);
report("A4 old query repro (contrast)", oldQ.status === 400 && oldQ.body?.code === "42703",
  `GET order_items?…&order=created_at.desc → ${oldQ.status} code=${oldQ.body?.code ?? "-"} (pre-fix crash, no longer issued)`);

// ---- B: catalog IDs match bookOrderWithFlaship expectations ----
const couriers = await get(`flaship_couriers?select=courier_id,name,active&order=name.asc&limit=30`);
const crows = Array.isArray(couriers.body) ? couriers.body : [];
const badCodes = crows.filter((c) => !/^[a-z0-9_]+$/.test(c.courier_id));
report("B1 courier_id payload-safe", couriers.status === 200 && crows.length > 0 && badCodes.length === 0,
  `${crows.length} couriers, all courier_id lowercase [a-z0-9_] → toLowerCase() no-op, exact code match${badCodes.length ? ` BAD=${badCodes.map((c) => c.courier_id).join(",")}` : ""}`);

const pickups = await get(`flaship_pickups?select=pickup_id,name,active&limit=10`);
const prows = Array.isArray(pickups.body) ? pickups.body : [];
const badPids = prows.filter((p) => !Number.isInteger(Number.parseInt(p.pickup_id, 10)) || Number.parseInt(p.pickup_id, 10) <= 0);
report("B2 pickup_id payload-safe", pickups.status === 200 && prows.length > 0 && badPids.length === 0,
  `${prows.length} pickup(s), pickup_id=${prows.map((p) => p.pickup_id).join("/")} → parseInt=${prows.map((p) => Number.parseInt(p.pickup_id, 10)).join("/")} ≠ 0 (service.ts:511)`);
report("B3 preselect has valid defaults", crows.length > 0 && prows.length > 0,
  `order-detail auto-select → courier_id="${crows[0]?.courier_id ?? ""}", pickup_id="${prows[0]?.pickup_id ?? ""}"`);

// ---- no side effects ----
const ordAgain = await get(`orders?select=booking_status,tracking_number,booking_error&id=eq.${order.id}`);
const o2 = Array.isArray(ordAgain.body) ? ordAgain.body[0] : {};
report("S1 order untouched", o2.booking_status === "not_booked" && !o2.tracking_number && !o2.booking_error,
  `booking_status=${o2.booking_status} tracking=${o2.tracking_number} error=${o2.booking_error}`);
const logs = await get("flaship_logs?select=id&limit=1", );
const logsCountRes = await fetch(`${URL_BASE}/rest/v1/flaship_logs?select=id&limit=1`, {
  headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, Prefer: "count=exact" },
});
const range = logsCountRes.headers.get("content-range");
const totalLogs = range ? Number(range.split("/")[1]) : null;
report("S2 no new flaship_logs", totalLogs === 6,
  `flaship_logs total=${totalLogs} (unchanged → zero Flaship HTTP calls, zero booking attempts)`);

console.log(`\nRESULT: ${failed === 0 ? "ALL PASS" : `${failed} FAILED`} — read-only, GET only, no Flaship contact.`);
process.exit(failed === 0 ? 0 : 1);
