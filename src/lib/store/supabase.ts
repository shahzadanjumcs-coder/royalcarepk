import { SupabaseClient } from "@supabase/supabase-js";
import type { ListOptions, ListResult, Store, TableName, WithId } from "./base";

type Row = Record<string, unknown>;

/**
 * Supabase-backed store adapter (production mode).
 * Runs server-side; RLS acts as defense-in-depth while services enforce
 * authorization explicitly before touching the store.
 */
/**
 * Tables without a `created_at` column. list() defaults to ordering by
 * created_at desc; for these tables fall back to a stable real column
 * (their own timestamp where one exists, otherwise the primary key) so the
 * default ordering never references a missing column — e.g. the settings 500
 * and the booking-path crash `column order_items.created_at does not exist`.
 */
const DEFAULT_ORDER_COLUMN: Partial<Record<TableName, string>> = {
  settings: "updated_at",
  flaship_couriers: "synced_at",
  flaship_cities: "synced_at",
  flaship_pickups: "synced_at",
  team_members: "joined_at",
  order_items: "id",
  shipment_tracking: "scanned_at",
};

export class SupabaseStore implements Store {
  constructor(private client: SupabaseClient) {}

  private q(table: TableName) {
    return this.client.from(table);
  }

  private buildFilters(query: any, opts: ListOptions): any {
    let q = query;
    if (opts.filters) {
      for (const [k, v] of Object.entries(opts.filters)) {
        if (v === undefined || v === null || v === "") continue;
        q = q.eq(k, v);
      }
    }
    if (opts.inFilters) {
      for (const [k, values] of Object.entries(opts.inFilters)) {
        if (!values || values.length === 0) continue;
        q = q.in(k, values as unknown[]);
      }
    }
    if (opts.nullFilters?.length) {
      for (const k of opts.nullFilters) {
        q = q.is(k, null);
      }
    }
    if (opts.search && opts.search.q) {
      const ors = opts.search.fields.map((f) => `${f}.ilike.%${opts.search!.q}%`).join(",");
      q = q.or(ors);
    }
    if (opts.dateRange && (opts.dateRange.from || opts.dateRange.to)) {
      const f = opts.dateRange.field;
      if (opts.dateRange.from) q = q.gte(f, opts.dateRange.from);
      if (opts.dateRange.to) q = q.lt(f, `${opts.dateRange.to}T23:59:59.999`);
    }
    return q;
  }

  async list<T>(table: TableName, opts: ListOptions = {}): Promise<ListResult<WithId<T>>> {
    // count: "exact" must be requested up-front so pagination totals are correct
    let q = this.buildFilters(this.q(table).select("*", { count: "exact" }), opts);
    if (opts.orderBy) {
      q = q.order(opts.orderBy.field, { ascending: opts.orderBy.dir === "asc" });
    } else {
      q = q.order(DEFAULT_ORDER_COLUMN[table] ?? "created_at", { ascending: false });
    }
    if (opts.perPage) {
      const page = Math.max(1, opts.page || 1);
      const start = (page - 1) * opts.perPage;
      q = q.range(start, start + opts.perPage - 1);
    }
    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    return { rows: (data ?? []) as unknown as WithId<T>[], total: count ?? (data ?? []).length };
  }

  async get<T>(table: TableName, id: string): Promise<WithId<T> | null> {
    const { data, error } = await this.q(table).select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    return (data as WithId<T>) ?? null;
  }

  async first<T>(table: TableName, filters: Record<string, unknown>): Promise<WithId<T> | null> {
    let q = this.q(table).select("*").limit(1);
    for (const [k, v] of Object.entries(filters)) {
      q = q.eq(k, v as unknown);
    }
    const { data, error } = await q.maybeSingle();
    if (error) throw new Error(error.message);
    return (data as WithId<T>) ?? null;
  }

  async insert<T>(table: TableName, data: Record<string, unknown>): Promise<WithId<T>> {
    const { data: row, error } = await this.q(table).insert(data).select("*").single();
    if (error) throw new Error(error.message);
    return row as WithId<T>;
  }

  async insertMany(table: TableName, rows: Row[]): Promise<void> {
    if (!rows.length) return;
    const { error } = await this.q(table).insert(rows);
    if (error) throw new Error(error.message);
  }

  /**
   * Bulk upsert resolved by the database against the UNIQUE constraint on
   * `conflictKeys` (PostgREST `Prefer: resolution=merge-duplicates`). One
   * round-trip regardless of row count — no read-back, so it is immune to the
   * ~1,000-row cap PostgREST applies to unpaginated selects.
   */
  async upsertMany(table: TableName, rows: Row[], conflictKeys: string[]): Promise<void> {
    if (!rows.length) return;
    const { error } = await this.q(table).upsert(rows, { onConflict: conflictKeys.join(",") });
    if (error) throw new Error(error.message);
  }

  async update<T>(table: TableName, id: string, data: Record<string, unknown>): Promise<WithId<T>> {
    const { data: row, error } = await this.q(table).update(data).eq("id", id).select("*").single();
    if (error) throw new Error(error.message);
    return row as WithId<T>;
  }

  async delete(table: TableName, id: string): Promise<void> {
    const { error } = await this.q(table).delete().eq("id", id);
    if (error) throw new Error(error.message);
  }

  async count(table: TableName, filters?: Record<string, unknown>): Promise<number> {
    let q = this.q(table).select("id", { count: "exact", head: true });
    if (filters) {
      for (const [k, v] of Object.entries(filters)) {
        if (v === undefined || v === null || v === "") continue;
        q = q.eq(k, v as unknown);
      }
    }
    const { count, error } = await q;
    if (error) throw new Error(error.message);
    return count ?? 0;
  }
}
