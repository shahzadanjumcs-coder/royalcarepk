/// <reference types="bun-types" />
/**
 * Flaship catalog-sync mapping tests — real syncCatalog(), mocked I/O seams.
 *
 * Regression coverage for "Sync Flaship merchant pickup list for courier
 * mapping": EVERY live catalog sync entry point (including type="pickups",
 * used by the pickup-points admin page) must persist the pickup↔courier
 * mapping (Flaship merchant_pickup_couriers) extracted from the official
 * GET /catalog/ response — previously the mapping was only persisted for
 * type="all"/"couriers", so syncing pickups never refreshed the mapping and
 * booking kept failing with "Pickup is not synced to this courier".
 *
 * All I/O is mocked: no database, no network, no secrets. The store records
 * every mutation so the persistence and stale-edge cleanup can be asserted.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";

// ---------------- mocks (registered BEFORE the service import) ----------------

// The service module is server-only; the test harness is not a React Server
// Component runtime, so stub the guard package out.
mock.module("server-only", () => ({}));

type Row = Record<string, unknown>;
const tableRows: Record<string, Row[]> = {
  settings: [],
  flaship_couriers: [],
  flaship_cities: [],
  flaship_pickups: [],
  flaship_pickup_couriers: [],
  flaship_logs: [],
};

const mutations: { kind: string; table: string; args?: unknown }[] = [];

function seed(table: string, row: Row) {
  tableRows[table].push(row);
}

function resetTables() {
  for (const key of Object.keys(tableRows)) tableRows[key] = [];
  mutations.length = 0;
}

mock.module("@/lib/store", () => ({
  IS_DEMO_MODE: false,
  store: {
    first: async (table: string, where?: { key?: string }) => {
      const rows = tableRows[table] ?? [];
      if (where?.key) return rows.find((r) => r.key === where.key) ?? null;
      return rows[0] ?? null;
    },
    list: async (table: string) => ({ rows: tableRows[table] ?? [], total: (tableRows[table] ?? []).length }),
    insert: async (table: string, row: Row) => {
      mutations.push({ kind: "insert", table });
      const full = { id: `id-${tableRows[table].length + 1}`, ...row };
      tableRows[table] = [...(tableRows[table] ?? []), full];
      return full;
    },
    update: async (table: string, id: string, patch: Row) => {
      mutations.push({ kind: "update", table, args: { id, patch } });
      tableRows[table] = (tableRows[table] ?? []).map((r) => (r.id === id ? { ...r, ...patch } : r));
      return { id, ...patch };
    },
    delete: async (table: string, id: string) => {
      mutations.push({ kind: "delete", table, args: { id } });
      tableRows[table] = (tableRows[table] ?? []).filter((r) => r.id !== id);
    },
    upsertMany: async (table: string, rows: Row[], _conflict: string[]) => {
      mutations.push({ kind: "upsertMany", table, args: { rows } });
      for (const row of rows) {
        const match = tableRows[table].find((r) => r.pickup_id === row.pickup_id && r.courier_id === row.courier_id);
        if (match) Object.assign(match, row);
        else tableRows[table] = [...tableRows[table], { id: `id-${tableRows[table].length + 1}`, ...row }];
      }
      return rows.length;
    },
  },
}));

mock.module("@/lib/crypto/secret-box", () => ({
  decryptSecret: () => "test-integration-key",
}));

mock.module("@/lib/services/audit", () => ({ logAudit: async () => undefined }));
mock.module("@/lib/services/notifications", () => ({ notifyAdmins: async () => undefined }));
mock.module("@/lib/services/orders", () => ({ changeOrderStatus: async () => undefined }));
mock.module("@/lib/services/whatsapp", () => ({ enqueueWhatsAppOrderEvent: async () => undefined }));

// OFFICIAL GET /catalog/ shape: companies[] carry their enabled pickup
// locations (the merchant_pickup_couriers projection); pickupAddress lists
// the merchant's pickup points; operational_cities lists cities.
const CATALOG_BODY = {
  companies: [
    {
      code: "Leopard",
      display_name: "Leopard Courier",
      pickups: [{ id: "PK-9012", name: "Royalcarepk Okara", address: "Depot Road, Okara", city: "Okara" }],
    },
    { code: "TCS", display_name: "TCS", pickups: [] },
  ],
  pickupAddress: [{ id: "PK-9012", name: "Royalcarepk Okara", address: "Depot Road, Okara", city: "Okara" }],
  operational_cities: ["Okara", "Lahore"],
};

let fetchCalls = 0;
const originalFetch = globalThis.fetch;
function stubFetchWithCatalog() {
  fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify(CATALOG_BODY), { status: 200 });
  }) as unknown as typeof fetch;
}

// ---------------- service import (after mocks) ----------------
const { syncCatalog } = await import("../src/lib/flaship/service");

beforeEach(() => {
  resetTables();
  fetchCalls = 0;
  globalThis.fetch = originalFetch;
});

describe("syncCatalog — pickup↔courier mapping persistence", () => {
  it("persists the mapping when syncing pickups (type='pickups') in live mode", async () => {
    seed("settings", { id: "s1", key: "flaship", value: { mode: "live", api_key_enc: "enc" } });
    stubFetchWithCatalog();

    const counts = await syncCatalog("pickups");

    expect(fetchCalls).toBe(1);
    expect(counts.pickups).toBe(1);
    expect(counts.links).toBe(1);

    const upserts = mutations.filter((m) => m.kind === "upsertMany" && m.table === "flaship_pickup_couriers");
    expect(upserts.length).toBe(1);
    const rows = (upserts[0].args as { rows: Record<string, unknown>[] }).rows;
    expect(rows).toEqual([{ pickup_id: "PK-9012", courier_id: "Leopard", synced_at: expect.any(String) }]);

    // pickups were persisted too (the merchant pickup list itself)
    expect(mutations.some((m) => m.kind === "upsertMany" && m.table === "flaship_pickups")).toBe(true);
  });

  it("removes stale mapping edges absent from the fresh catalog (full refresh)", async () => {
    seed("settings", { id: "s1", key: "flaship", value: { mode: "live", api_key_enc: "enc" } });
    seed("flaship_pickup_couriers", { id: "m-old", pickup_id: "PK-STALE", courier_id: "Leopard" });
    stubFetchWithCatalog();

    await syncCatalog("pickups");

    const deletes = mutations.filter((m) => m.kind === "delete" && m.table === "flaship_pickup_couriers");
    expect(deletes.length).toBe(1);
    expect((deletes[0].args as { id: string }).id).toBe("m-old");
  });

  it("never persists or wipes mapping rows outside live mode (simulator)", async () => {
    // No API key stored → simulator mode; catalog comes from local tables.
    seed("settings", { id: "s1", key: "flaship", value: { mode: "simulator" } });

    const counts = await syncCatalog("pickups");

    expect(fetchCalls).toBe(0);
    expect(counts.links).toBe(0);
    expect(mutations.some((m) => m.table === "flaship_pickup_couriers")).toBe(false);
  });

  it("refreshes the mapping from the 'couriers' entry point as before (no regression)", async () => {
    seed("settings", { id: "s1", key: "flaship", value: { mode: "live", api_key_enc: "enc" } });
    stubFetchWithCatalog();

    const counts = await syncCatalog("couriers");

    expect(counts.links).toBe(1);
    expect(mutations.some((m) => m.kind === "upsertMany" && m.table === "flaship_pickup_couriers")).toBe(true);
  });
});
