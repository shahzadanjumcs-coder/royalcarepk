#!/usr/bin/env node
// Task 20 READ-ONLY audit: Supabase connection + required tables + counts
// GET requests only. NEVER prints URL/keys/secrets — only statuses, counts, column names.
import { readFileSync } from "node:fs";

// --- load env silently ---
function loadEnv(path) {
  try {
    const txt = readFileSync(path, "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* absent file ignored */ }
}
loadEnv("/home/z/my-project/.env.local");
loadEnv("/home/z/my-project/.env");

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.log("SKIP: Supabase URL/service key not configured"); process.exit(0); }

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: "count=exact" };

async function probe(table) {
  try {
    const r = await fetch(`${URL}/rest/v1/${table}?select=*&limit=1`, { headers: H });
    const cr = r.headers.get("content-range"); // e.g. "0-0/2762"
    const count = cr ? cr.split("/")[1] : "?";
    let cols = [];
    if (r.ok) { const j = await r.json(); if (j[0]) cols = Object.keys(j[0]); }
    return { table, status: r.status, count, cols };
  } catch (e) { return { table, status: `ERR:${e.cause?.code || e.message?.slice(0, 30)}`, count: "?", cols: [] }; }
}

// 0) project health
try {
  const h = await fetch(`${URL}/auth/v1/health`, { headers: { apikey: KEY } });
  console.log(`supabase /auth/v1/health -> ${h.status}`);
} catch (e) { console.log(`supabase health -> ERR ${e.cause?.code || e.message?.slice(0, 40)}`); }

const tables = [
  "profiles","teams","team_members","customers","categories","suppliers","products",
  "inventory_movements","orders","order_items","order_status_history","shipments",
  "shipment_tracking","commission_transactions","commission_rules","worker_payments",
  "flaship_couriers","flaship_cities","flaship_pickups","flaship_logs","notifications",
  "audit_logs","settings",
];

let pass = 0, fail = 0;
for (const t of tables) {
  const r = await probe(t);
  const ok = r.status === 200 || r.status === 206; // 206 = rows>limit, still queryable
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${r.table.padEnd(24)} ${r.status}  rows=${r.count}${ok && r.cols.length ? "  cols=" + r.cols.length : ""}`);
}
console.log(`\ntables: ${pass} pass / ${fail} fail`);

// settings row — whitelist non-secret fields only
{
  const r2 = await fetch(`${URL}/rest/v1/settings?select=*&order=id.asc`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r2.ok) { console.log(`\nsettings detail -> ${r2.status}`); }
  else {
    const rows = await r2.json();
    const secretish = /key|secret|token|enc|password|url/i;
    const printable = /mode|type|courier|pickup|weight|timeout|delay|default|label|name/i;
    console.log(`\nsettings rows: ${rows.length}`);
    for (const row of rows) {
      const parts = [];
      for (const [k, v] of Object.entries(row)) {
        const empty = v == null || v === "";
        if (secretish.test(k)) parts.push(`${k}=${empty ? "EMPTY" : "SET(hidden)"}`);
        else if (printable.test(k)) parts.push(`${k}=${JSON.stringify(v)}`);
        else parts.push(`${k}=${empty ? "EMPTY" : "SET"}`);
      }
      console.log("  " + parts.join(" | "));
    }
  }
}
