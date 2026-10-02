/**
 * READ-ONLY verification of the catalog ordering fix (Task: "Refresh Catalog"
 * failing with `column flaship_couriers.created_at does not exist`).
 *
 * Guarantees:
 *  - GET requests only. No insert/update/delete. No migrations.
 *  - NO Flaship API calls (only Supabase PostgREST endpoints are touched).
 *  - Secrets (service-role key / anon key) are loaded from .env.local and are
 *    NEVER printed; only status codes, error codes and row counts are reported.
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
  console.error("FATAL: required env missing (checked PRESENT only, values not shown)");
  process.exit(1);
}
console.log(`env: NEXT_PUBLIC_SUPABASE_URL=PRESENT, SUPABASE_SERVICE_ROLE_KEY=PRESENT, url_host=${new URL(URL_BASE).host}`);

let failed = 0;
function report(id, pass, detail) {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${id.padEnd(6)} ${detail}`);
}

async function probe(table, orderExpr) {
  const url = `${URL_BASE}/rest/v1/${table}?select=id&limit=1${orderExpr ? `&order=${orderExpr}` : ""}`;
  const res = await fetch(url, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  });
  let body = null;
  try { body = await res.json(); } catch { /* empty body ok */ }
  return { status: res.status, body };
}

// 1. New default-order queries (what SupabaseStore.list now issues) must return 200
for (const [table, col] of [
  ["flaship_couriers", "synced_at.desc"],
  ["flaship_cities", "synced_at.desc"],
  ["flaship_pickups", "synced_at.desc"],
  ["team_members", "joined_at.desc"],
  ["order_items", "id.asc"],
]) {
  const { status, body } = await probe(table, col);
  report(`NEW:${table}`, status === 200, `GET ${table}?order=${col} → ${status}${status !== 200 ? ` ${JSON.stringify(body)?.slice(0, 120)}` : ""}`);
}

// 2. Root-cause proof: the OLD query (order=created_at) must still reproduce 42703
const old = await probe("flaship_couriers", "created_at.desc");
const code = old.body?.code ?? "";
const msg = old.body?.message ?? "";
report(
  "OLD-BUG",
  old.status === 400 && /created_at|does not exist/i.test(msg),
  `GET flaship_couriers?order=created_at.desc → ${old.status} code=${code} msg="${String(msg).slice(0, 90)}"`,
);

// 3. Catalog tables untouched by the failed refresh (counts only, no row data)
for (const table of ["flaship_couriers", "flaship_cities", "flaship_pickups"]) {
  const res = await fetch(`${URL_BASE}/rest/v1/${table}?select=id`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, Prefer: "count=exact", Range: "0-0" },
  });
  const range = res.headers.get("content-range") ?? ""; // e.g. "0-0/12"
  const count = range.split("/")[1] ?? "?";
  report(`COUNT:${table}`, res.status === 200, `${table} rows=${count} (read-only count)`);
}

console.log(`\nRESULT: ${failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
