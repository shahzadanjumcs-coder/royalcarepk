/// <reference types="bun-types" />
/**
 * Store default-order schema parity (regression for the production Deals-page
 * 500 on commit 2da853d).
 *
 * ROOT CAUSE (production, vercel deployment of 2da853d):
 *   SupabaseStore.list() defaults to `order(created_at desc)` whenever a
 *   caller passes no explicit orderBy. `deal_items` (migration 0009) has NO
 *   created_at column, so every un-ordered store.list("deal_items") — the
 *   deals page list, deal detail, deal editing and order-time deal resolution
 *   — crashed with PGRST204 "column deal_items.created_at does not exist",
 *   surfacing as "Something went wrong. Please try again." on /admin/deals.
 *
 * The store keeps a DEFAULT_ORDER_COLUMN map for exactly this (precedents:
 * flaship_pickup_couriers, whatsapp_routing_settings, order_items, …). This
 * test parses the REAL migration files and enforces two-way parity:
 *   1. every schema table lacking created_at MUST be mapped;
 *   2. every mapped table must actually lack created_at (no stale entries).
 * It runs against the shipped migrations, so any future migration that adds
 * a created_at-less table fails here BEFORE it can 500 in production.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_ORDER_COLUMN } from "@/lib/store/supabase";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "supabase", "migrations");

interface TableDef {
  name: string;
  columns: Set<string>;
}

/** Parse `create table [if not exists] public.<name> ( ... )` blocks with
 *  paren-aware body extraction (CHECK constraints nest parentheses). */
function parseCreateTables(sql: string): TableDef[] {
  const tables: TableDef[] = [];
  const createRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z_][a-z0-9_]*)\s*\(/gi;
  for (const m of sql.matchAll(createRe)) {
    const name = m[1];
    // Walk from the opening paren to its MATCHING close (nested parens counted).
    let i = m.index + m[0].length;
    let depth = 1;
    let body = "";
    while (i < sql.length && depth > 0) {
      const ch = sql[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
      body += ch;
      i++;
    }
    const columns = new Set<string>();
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("--")) continue;
      // Skip table-level constraints (first token is a constraint keyword).
      const first = line.split(/[\s(]/)[0].toLowerCase();
      if (["primary", "unique", "foreign", "check", "constraint", "exclude"].includes(first)) continue;
      const col = line.match(/^([a-z_][a-z0-9_]*)\s+[a-z"]/i);
      if (col) columns.add(col[1].toLowerCase());
    }
    tables.push({ name, columns });
  }
  return tables;
}

/** Columns added later via `alter table … add column [if not exists] <name>`. */
function parseAddedColumns(sql: string): Map<string, Set<string>> {
  const added = new Map<string, Set<string>>();
  const re = /alter\s+table\s+(?:if\s+exists\s+)?public\.([a-z_][a-z0-9_]*)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/gi;
  for (const m of sql.matchAll(re)) {
    if (!added.has(m[1])) added.set(m[1], new Set());
    added.get(m[1])!.add(m[2].toLowerCase());
  }
  return added;
}

function schemaTables(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    for (const t of parseCreateTables(sql)) map.set(t.name, t.columns);
    for (const [table, cols] of parseAddedColumns(sql)) {
      if (!map.has(table)) map.set(table, new Set());
      for (const c of cols) map.get(table)!.add(c);
    }
  }
  return map;
}

describe("SupabaseStore default ordering vs real schema", () => {
  const schema = schemaTables();

  it("found the expected migration tables (parser sanity)", () => {
    expect(schema.has("deals")).toBe(true);
    expect(schema.has("deal_items")).toBe(true);
    expect(schema.has("order_items")).toBe(true);
    expect(schema.has("products")).toBe(true);
  });

  it("deal_items really has no created_at column (precondition from 0009)", () => {
    expect(schema.get("deal_items")!.has("created_at")).toBe(false);
  });

  it("every schema table without created_at is mapped in DEFAULT_ORDER_COLUMN", () => {
    const unmapped = [...schema.entries()]
      .filter(([, cols]) => !cols.has("created_at"))
      .map(([name]) => name)
      .filter((name) => !(name in DEFAULT_ORDER_COLUMN));
    expect(unmapped).toEqual([]);
  });

  it("no stale mappings: every DEFAULT_ORDER_COLUMN key lacks created_at in the schema", () => {
    const stale = Object.keys(DEFAULT_ORDER_COLUMN).filter((name) => {
      const cols = schema.get(name);
      return cols ? cols.has("created_at") : false; // unknown table = stale too
    });
    expect(stale).toEqual([]);
  });

  it("deals table (0009) has created_at so its default ordering is safe", () => {
    expect(schema.get("deals")!.has("created_at")).toBe(true);
    expect("deals" in DEFAULT_ORDER_COLUMN).toBe(false);
  });
});
