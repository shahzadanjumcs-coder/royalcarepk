/// <reference types="bun-types" />
/**
 * SupabaseStore default-order regression tests.
 *
 * Production incident (after d3aab49): tables WITHOUT a created_at column
 * crash store.list() when no explicit orderBy is given, because the fallback
 * orders by "created_at" → PostgREST 42703 → HTTP 500. This has bitten twice:
 *   - whatsapp_routing_settings (0004) → GET /api/whatsapp/settings 500
 *   - flaship_pickup_couriers (0006)   → GET /api/lookup + GET /api/flaship/catalog 500
 *                                     → empty booking courier dropdown
 *
 * DEFAULT_ORDER_COLUMN must therefore cover every created_at-less table.
 * The store is driven through a fake supabase-js client (no DB, no network).
 */
import { describe, it, expect } from "bun:test";
import { SupabaseStore } from "../src/lib/store/supabase";

interface Recorded {
  table: string;
  selectArg?: unknown;
  orderField?: string;
  orderOpts?: unknown;
}

function makeFakeClient(record: Recorded, result: { data: unknown[]; error: unknown; count: number }) {
  const builder: Record<string, unknown> = {
    select(arg: unknown) {
      record.selectArg = arg;
      return builder;
    },
    order(field: string, opts?: unknown) {
      record.orderField = field;
      record.orderOpts = opts;
      return builder;
    },
    eq() {
      return builder;
    },
    range() {
      return builder;
    },
    // supabase-js builders are thenable — list() awaits the chain directly
    then(onFulfilled: (v: { data: unknown[]; error: unknown; count: number }) => unknown) {
      return Promise.resolve(result).then(onFulfilled);
    },
  };
  return {
    from(table: string) {
      record.table = table;
      return builder;
    },
  };
}

describe("SupabaseStore.list default order column", () => {
  it("orders flaship_pickup_couriers by synced_at (NOT created_at)", async () => {
    const record = {} as Recorded;
    const store = new SupabaseStore(makeFakeClient(record, { data: [], error: null, count: 0 }) as never);
    await store.list("flaship_pickup_couriers");
    expect(record.orderField).toBe("synced_at");
  });

  it("keeps the other created_at-less flaship catalog tables on synced_at", async () => {
    for (const table of ["flaship_couriers", "flaship_cities", "flaship_pickups"] as const) {
      const record = {} as Recorded;
      const store = new SupabaseStore(makeFakeClient(record, { data: [], error: null, count: 0 }) as never);
      await store.list(table);
      expect(record.orderField).toBe("synced_at");
    }
  });

  it("keeps whatsapp tables on updated_at (previous incident remains fixed)", async () => {
    for (const table of ["whatsapp_routing_settings", "whatsapp_bot_settings"] as const) {
      const record = {} as Recorded;
      const store = new SupabaseStore(makeFakeClient(record, { data: [], error: null, count: 0 }) as never);
      await store.list(table);
      expect(record.orderField).toBe("updated_at");
    }
  });

  it("an explicit orderBy always wins over the default", async () => {
    const record = {} as Recorded;
    const store = new SupabaseStore(makeFakeClient(record, { data: [], error: null, count: 0 }) as never);
    await store.list("flaship_pickup_couriers", { orderBy: { field: "courier_id", dir: "asc" } });
    expect(record.orderField).toBe("courier_id");
  });

  it("surfaces store errors instead of swallowing them (routes turn them into 500)", async () => {
    const record = {} as Recorded;
    const store = new SupabaseStore(makeFakeClient(record, { data: [], error: { message: "column x does not exist" }, count: 0 }) as never);
    await expect(store.list("flaship_pickup_couriers")).rejects.toThrow("column x does not exist");
  });
});
