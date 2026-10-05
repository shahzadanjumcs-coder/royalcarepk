#!/usr/bin/env node
// RoyalCarePK — regression guard for DEFAULT_ORDER_COLUMN (static, offline).
//
// Bug class it guards: SupabaseStore.list() falls back to ordering by
// `created_at` unless a table has an entry in DEFAULT_ORDER_COLUMN. A table
// without a created_at column then makes EVERY default-ordered list() fail —
// e.g. GET /api/whatsapp/settings 500'd with
// `column whatsapp_routing_settings.created_at does not exist` (PGRST204)
// while every other panel worked.
//
// Checks, purely from files (no DB, no secrets):
//   1. every migration table WITHOUT created_at must have a DEFAULT_ORDER_COLUMN entry
//   2. every entry's target column must really exist in that table's migration
//   3. TableName union members that have no migration CREATE block are reported (warning)
// Exit 1 on any violation — run: node scripts/verify_default_order_columns.mjs
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "supabase", "migrations");

// ---- 1. parse migrations: table -> Set(columns) ----------------------------
const tables = new Map();
for (const f of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
  const sql = readFileSync(join(migrationsDir, f), "utf8");
  for (const m of sql.matchAll(/create table if not exists (?:public\.)?(\w+) \((.*?)\n\);/gs)) {
    const cols = new Set();
    for (const line of m[2].split("\n")) {
      const c = line.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s/);
      if (c) cols.add(c[1]);
    }
    // merged across migrations (0002+ may extend 0001 tables)
    tables.set(m[1], new Set([...(tables.get(m[1]) ?? []), ...cols]));
  }
}

// ---- 2. parse base.ts TableName union --------------------------------------
const baseSrc = readFileSync(join(root, "src/lib/store/base.ts"), "utf8");
const unionBlock = baseSrc.match(/export type TableName =([\s\S]*?);/)[1];
const appTables = [...unionBlock.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);

// ---- 3. parse supabase.ts DEFAULT_ORDER_COLUMN ------------------------------
const sbSrc = readFileSync(join(root, "src/lib/store/supabase.ts"), "utf8");
const mapBlock = sbSrc.match(/const DEFAULT_ORDER_COLUMN[^=]*= \{([\s\S]*?)\n\};/)[1];
const orderCol = new Map();
for (const m of mapBlock.matchAll(/(?:^|,)\s*([a-z_]+):\s*"([a-zA-Z_]+)"/gm)) orderCol.set(m[1], m[2]);

// ---- 4. checks --------------------------------------------------------------
let failures = 0;
const warn = (msg) => console.log(`WARN  ${msg}`);
const fail = (msg) => { console.log(`FAIL  ${msg}`); failures++; };
const ok = (msg) => console.log(`OK    ${msg}`);

for (const t of appTables) {
  const cols = tables.get(t);
  if (!cols) { warn(`TableName "${t}" has no CREATE TABLE in migrations — cannot verify.`); continue; }
  const hasCreatedAt = cols.has("created_at");
  const mapped = orderCol.get(t);
  if (!hasCreatedAt && !mapped) {
    fail(`"${t}" lacks created_at AND has no DEFAULT_ORDER_COLUMN entry — any default-ordered list() will 500 (the routing-settings bug class).`);
  } else if (mapped && !cols.has(mapped)) {
    fail(`DEFAULT_ORDER_COLUMN["${t}"] = "${mapped}" but that column does not exist in the migration (columns: ${[...cols].join(", ")}).`);
  } else if (!hasCreatedAt) {
    ok(`"${t}" (no created_at) defaults to "${mapped}" — column exists.`);
  }
}

for (const [t, col] of orderCol) {
  if (!appTables.includes(t)) warn(`DEFAULT_ORDER_COLUMN["${t}"] is not in the TableName union (stale entry?).`);
  if (!tables.get(t)?.has(col) && tables.has(t)) { /* already covered above */ }
}

console.log(failures === 0 ? "\nRESULT: PASS — default order columns are consistent with migrations." : `\nRESULT: FAIL — ${failures} violation(s).`);
process.exit(failures === 0 ? 0 : 1);
