import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import type { ListOptions, ListResult, Store, TableName, WithId } from "./base";
import { nextDayISO } from "./base";

type Row = Record<string, unknown> & { id: string };
type Database = Record<string, Row[]>;

const PERSIST_FILE = path.join(process.cwd(), "data", "demo-store.json");

function emptyDb(): Database {
  return {};
}

function matches(row: Row, filters?: Record<string, unknown>): boolean {
  if (!filters) return true;
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined) continue;
    if (row[k] !== v) return false;
  }
  return true;
}

function matchesSearch(row: Row, search?: { q: string; fields: string[] }): boolean {
  if (!search || !search.q) return true;
  const q = search.q.toLowerCase();
  return search.fields.some((f) => {
    const v = row[f];
    return v !== null && v !== undefined && String(v).toLowerCase().includes(q);
  });
}

function matchesDate(row: Row, range?: ListOptions["dateRange"]): boolean {
  if (!range || (!range.from && !range.to)) return true;
  const raw = row[range.field];
  if (!raw) return false;
  const day = String(raw).slice(0, 10);
  if (range.from && day < range.from) return false;
  if (range.to && day > range.to) return false;
  return true;
}

class MemoryStore implements Store {
  private db: Database = emptyDb();
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = this._load();
    }
    await this.loadPromise;
  }

  private async _load(): Promise<void> {
    try {
      const raw = await fs.readFile(PERSIST_FILE, "utf-8");
      const parsed = JSON.parse(raw) as Database;
      if (parsed && typeof parsed === "object" && parsed.profiles?.length) {
        this.db = parsed;
        this.loaded = true;
        return;
      }
    } catch {
      // no file yet
    }
    const { buildSeed } = await import("./seed");
    this.db = await buildSeed();
    this.loaded = true;
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void this._save();
    }, 400);
  }

  private async _save(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(PERSIST_FILE), { recursive: true });
      await fs.writeFile(PERSIST_FILE, JSON.stringify(this.db));
    } catch {
      // persistence is best-effort in demo mode
    }
  }

  async reset(): Promise<void> {
    const { buildSeed } = await import("./seed");
    this.db = await buildSeed();
    this.loaded = true;
    await this._save();
  }

  private table(name: TableName): Row[] {
    if (!this.db[name]) this.db[name] = [];
    return this.db[name];
  }

  async list<T>(table: TableName, opts: ListOptions = {}): Promise<ListResult<WithId<T>>> {
    await this.ensureLoaded();
    let rows = this.table(table).filter(
      (r) => matches(r, opts.filters) && matchesSearch(r, opts.search) && matchesDate(r, opts.dateRange)
    );
    if (opts.nullFilters?.length) {
      rows = rows.filter((r) => opts.nullFilters!.every((k) => r[k] === null || r[k] === undefined || r[k] === ""));
    }
    if (opts.inFilters) {
      for (const [k, values] of Object.entries(opts.inFilters)) {
        if (!values || values.length === 0) continue;
        rows = rows.filter((r) => values.includes(r[k]));
      }
    }
    if (opts.orderBy) {
      const { field, dir } = opts.orderBy;
      rows = [...rows].sort((a, b) => {
        const av = a[field] as string | number | null;
        const bv = b[field] as string | number | null;
        if (av === bv) return 0;
        const cmp = (av ?? "") > (bv ?? "") ? 1 : -1;
        return dir === "asc" ? cmp : -cmp;
      });
    }
    const total = rows.length;
    if (opts.perPage) {
      const page = Math.max(1, opts.page || 1);
      const start = (page - 1) * opts.perPage;
      rows = rows.slice(start, start + opts.perPage);
    }
    return { rows: rows as unknown as WithId<T>[], total };
  }

  async get<T>(table: TableName, id: string): Promise<WithId<T> | null> {
    await this.ensureLoaded();
    return (this.table(table).find((r) => r.id === id) as WithId<T>) ?? null;
  }

  async first<T>(table: TableName, filters: Record<string, unknown>): Promise<WithId<T> | null> {
    await this.ensureLoaded();
    return (this.table(table).find((r) => matches(r, filters)) as WithId<T>) ?? null;
  }

  async insert<T>(table: TableName, data: Record<string, unknown>): Promise<WithId<T>> {
    await this.ensureLoaded();
    const now = new Date().toISOString();
    const row: Row = {
      id: (data.id as string) || randomUUID(),
      created_at: (data.created_at as string) || now,
      ...data,
    } as Row;
    this.table(table).push(row);
    this.scheduleSave();
    return row as WithId<T>;
  }

  async insertMany(table: TableName, rows: Record<string, unknown>[]): Promise<void> {
    await this.ensureLoaded();
    for (const data of rows) {
      const row: Row = {
        id: (data.id as string) || randomUUID(),
        created_at: (data.created_at as string) || new Date().toISOString(),
        ...data,
      } as Row;
      this.table(table).push(row);
    }
    this.scheduleSave();
  }

  /** Merge rows sharing all `conflictKeys` values in place; insert the rest. */
  async upsertMany(table: TableName, rows: Record<string, unknown>[], conflictKeys: string[]): Promise<void> {
    await this.ensureLoaded();
    const target = this.table(table);
    for (const data of rows) {
      const existing = target.find((r) => conflictKeys.every((k) => r[k] === data[k]));
      if (existing) {
        Object.assign(existing, data);
      } else {
        const row: Row = {
          id: (data.id as string) || randomUUID(),
          created_at: (data.created_at as string) || new Date().toISOString(),
          ...data,
        } as Row;
        target.push(row);
      }
    }
    this.scheduleSave();
  }

  async update<T>(table: TableName, id: string, data: Record<string, unknown>): Promise<WithId<T>> {
    await this.ensureLoaded();
    const rows = this.table(table);
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) throw new Error(`Record not found in ${table}`);
    const updated = { ...rows[idx], ...data, id, updated_at: new Date().toISOString() } as Row;
    rows[idx] = updated;
    this.scheduleSave();
    return updated as WithId<T>;
  }

  async delete(table: TableName, id: string): Promise<void> {
    await this.ensureLoaded();
    const rows = this.table(table);
    const idx = rows.findIndex((r) => r.id === id);
    if (idx !== -1) rows.splice(idx, 1);
    this.scheduleSave();
  }

  async count(table: TableName, filters?: Record<string, unknown>): Promise<number> {
    await this.ensureLoaded();
    return this.table(table).filter((r) => matches(r, filters)).length;
  }
}

const globalForStore = globalThis as unknown as { __royalCarePkMemoryStore?: MemoryStore };

export const memoryStore: MemoryStore = globalForStore.__royalCarePkMemoryStore ?? new MemoryStore();
if (process.env.NODE_ENV !== "production") globalForStore.__royalCarePkMemoryStore = memoryStore;
