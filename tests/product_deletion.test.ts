/// <reference types="bun-types" />
/**
 * Product deletion / deal + inventory integrity (post-Audit-2 fix).
 *
 * DELETE /api/products/[id] contract:
 *   - super_admin/admin only (workers and inventory_manager → 403)
 *   - product with ANY relationship is NEVER hard-deleted — soft-disabled:
 *       order_items.product_id         ON DELETE SET NULL   (0001_init.sql)
 *       inventory_movements.product_id ON DELETE CASCADE    (0001_init.sql)
 *       deal_items.product_id          ON DELETE CASCADE    (0009_deals.sql)
 *     → order history, deal bundles and the append-only inventory ledger
 *       must never be silently damaged
 *   - product with NO references → hard delete stays available
 *   - response format preserved: { success, disabled?, message? }
 *
 * Also covers: deal integrity after disable (components intact, bundle price
 * unchanged, order-time resolution blocked with a clear error until the
 * product is re-enabled), historical snapshots untouched, and demo-mode
 * MemoryStore FK emulation (cascade / set-null parity with production).
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";

mock.module("server-only", () => ({}));

type Row = Record<string, unknown>;
let tables: Record<string, Row[]> = {};
const updates: { table: string; id: string; patch: Row }[] = [];
const deletes: { table: string; id: string }[] = [];

function seed() {
  tables = {
    products: [
      // pt-free: no orders, no deals, no movements → safe to hard delete
      { id: "pt-free", name: "Fresh Item", sku: "FR", status: "active", selling_price: 500, current_stock: 10, reserved_stock: 0 },
      // pt-ordered: ordinary order history
      { id: "pt-ordered", name: "Classic Oil", sku: "CO", status: "active", selling_price: 1200, current_stock: 20, reserved_stock: 0 },
      // pt-inactive-deal: member of an INACTIVE deal only
      { id: "pt-inactive-deal", name: "Paused Kit Item", sku: "PKI", status: "active", selling_price: 300, current_stock: 5, reserved_stock: 0 },
      // pt-dealcomp: member of an ACTIVE deal, no ordinary order history
      { id: "pt-dealcomp", name: "Bundle Serum", sku: "BS", status: "active", selling_price: 800, current_stock: 30, reserved_stock: 0 },
      // pt-dealonly-sold: sold ONLY via a bundle (order_items.product_id is NULL)
      { id: "pt-dealonly-sold", name: "Bundle Oil", sku: "BO", status: "active", selling_price: 900, current_stock: 15, reserved_stock: 0 },
      // pt-moved: only inventory movement history (stock received, never sold)
      { id: "pt-moved", name: "Stocked Cream", sku: "SC", status: "active", selling_price: 650, current_stock: 40, reserved_stock: 0 },
      // pt-everything: order history + deal membership + movement history
      { id: "pt-everything", name: "Veteran Product", sku: "VET", status: "active", selling_price: 1500, current_stock: 50, reserved_stock: 0 },
      // the other (healthy) component of the active deal
      { id: "pt-other-comp", name: "Bundle Lotion", sku: "BL", status: "active", selling_price: 700, current_stock: 25, reserved_stock: 0 },
    ],
    deals: [
      { id: "d-active", name: "Spa Bundle", description: null, selling_price: 2500, status: "active", created_by: "u-admin", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
      { id: "d-inactive", name: "Paused Kit", description: null, selling_price: 900, status: "inactive", created_by: "u-admin", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
    ],
    deal_items: [
      { id: "di-1", deal_id: "d-active", product_id: "pt-dealcomp", quantity: 1 },
      { id: "di-2", deal_id: "d-active", product_id: "pt-other-comp", quantity: 2 },
      { id: "di-3", deal_id: "d-inactive", product_id: "pt-inactive-deal", quantity: 1 },
      { id: "di-4", deal_id: "d-active", product_id: "pt-dealonly-sold", quantity: 1 },
      { id: "di-5", deal_id: "d-active", product_id: "pt-everything", quantity: 1 },
    ],
    orders: [
      { id: "o1", customer_id: "c1", status: "DELIVERED", total: 2400 },
      { id: "o2", customer_id: "c1", status: "BOOKED", total: 2500 },
    ],
    order_items: [
      // ordinary line — product_id set
      { id: "oi-1", order_id: "o1", product_id: "pt-ordered", product_name: "Classic Oil", sku: "CO", quantity: 2, unit_price: 1200, line_total: 2400 },
      // bundle line — product_id NULL, deal snapshot instead
      { id: "oi-2", order_id: "o2", product_id: null, deal_id: "d-active", product_name: "Spa Bundle", sku: null, quantity: 1, unit_price: 2500, line_total: 2500, components: [{ product_id: "pt-dealonly-sold", name: "Bundle Oil", quantity: 1 }, { product_id: "pt-other-comp", name: "Other", quantity: 2 }] },
      // ordinary historical line for pt-everything
      { id: "oi-3", order_id: "o1", product_id: "pt-everything", product_name: "Veteran Product", sku: "VET", quantity: 1, unit_price: 1500, line_total: 1500 },
    ],
    inventory_movements: [
      { id: "mv-1", product_id: "pt-moved", order_id: null, type: "STOCK_IN", quantity: 40, reserved_change: 0, balance_after: 40, reserved_after: 0, created_at: "2026-02-01T00:00:00Z" },
      { id: "mv-2", product_id: "pt-everything", order_id: "o1", type: "STOCK_IN", quantity: 50, reserved_change: 0, balance_after: 50, reserved_after: 0, created_at: "2026-02-01T00:00:00Z" },
    ],
    audit_logs: [],
  };
}

mock.module("@/lib/auth/session", () => ({
  getSession: async () => mockSession,
}));
mock.module("@/lib/services/audit", () => ({ logAudit: async () => undefined }));
mock.module("@/lib/store", () => ({
  IS_DEMO_MODE: false,
  store: {
    get: async (table: string, id: string) => (tables[table] ?? []).find((r) => r.id === id) ?? null,
    list: async (table: string, opts?: { filters?: Row }) => {
      let rows = tables[table] ?? [];
      const f = opts?.filters;
      if (f) rows = rows.filter((r) => Object.entries(f).every(([k, v]) => r[k] === v));
      return { rows, total: rows.length };
    },
    first: async () => null,
    update: async (table: string, id: string, patch: Row) => {
      updates.push({ table, id, patch });
      const row = (tables[table] ?? []).find((r) => r.id === id);
      if (row) Object.assign(row, patch);
      return { id, ...patch };
    },
    insert: async (table: string, row: Row) => {
      const full = { id: `id-${table}-${Math.random()}`, ...row };
      tables[table] = [...(tables[table] ?? []), full];
      return full;
    },
    delete: async (table: string, id: string) => {
      deletes.push({ table, id });
      tables[table] = (tables[table] ?? []).filter((r) => r.id !== id);
    },
    count: async (table: string, filters?: Row) => {
      let rows = tables[table] ?? [];
      if (filters) rows = rows.filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
      return rows.length;
    },
  },
}));

let mockSession: { userId: string; email: string; name: string; role: string; mode: string } | null = {
  userId: "u-admin",
  email: "a@rc.pk",
  name: "Admin",
  role: "admin",
  mode: "supabase",
};

const { DELETE, PATCH } = await import("../src/app/api/products/[id]/route");
const { resolveDealForOrder } = await import("../src/lib/services/deals");
const { MemoryStore } = await import("../src/lib/store/memory");

beforeEach(() => {
  seed();
  updates.length = 0;
  deletes.length = 0;
  mockSession = { userId: "u-admin", email: "a@rc.pk", name: "Admin", role: "admin", mode: "supabase" };
});

const del = (id: string) => new Request(`http://x/api/products/${id}`, { method: "DELETE" });
const ctxFor = (id: string) => ({ params: Promise.resolve({ id }) });
const patchJSON = (payload: unknown, id: string) =>
  new Request(`http://x/api/products/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
  });

describe("DELETE /api/products/[id] — authorization", () => {
  it("rejects workers and inventory managers (403)", async () => {
    mockSession = { userId: "u-w", email: "w@rc.pk", name: "W", role: "worker", mode: "supabase" };
    const res1 = await DELETE(del("pt-free"), ctxFor("pt-free"));
    expect(res1.status).toBe(403);

    mockSession = { userId: "u-im", email: "im@rc.pk", name: "IM", role: "inventory_manager", mode: "supabase" };
    const res2 = await DELETE(del("pt-free"), ctxFor("pt-free"));
    expect(res2.status).toBe(403);
    expect(deletes).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("returns 404 for an unknown product (before any counts)", async () => {
    const res = await DELETE(del("pt-missing"), ctxFor("pt-missing"));
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/products/[id] — hard delete only when fully unreferenced", () => {
  it("hard-deletes a product with no orders, no deals, no movements", async () => {
    const res = await DELETE(del("pt-free"), ctxFor("pt-free"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success?: boolean; disabled?: boolean };
    expect(body.success).toBe(true);
    expect(body.disabled).toBeUndefined();
    expect(deletes.some((d) => d.table === "products" && d.id === "pt-free")).toBe(true);
    expect(updates).toHaveLength(0);
  });
});

describe("DELETE /api/products/[id] — soft-disable instead of destructive delete", () => {
  it("product with ordinary order history → disabled (legacy behavior preserved)", async () => {
    const res = await DELETE(del("pt-ordered"), ctxFor("pt-ordered"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disabled?: boolean; message?: string };
    expect(body.disabled).toBe(true);
    expect(body.message).toContain("order history");
    expect(body.message).toContain("deactivated instead of deleted");
    expect(deletes).toHaveLength(0);
    expect(updates.some((u) => u.table === "products" && u.id === "pt-ordered" && u.patch.status === "inactive")).toBe(true);
  });

  it("product in an ACTIVE deal with no order history → disabled, deal components intact", async () => {
    const res = await DELETE(del("pt-dealcomp"), ctxFor("pt-dealcomp"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disabled?: boolean; message?: string };
    expect(body.disabled).toBe(true);
    expect(body.message).toContain("deal membership");
    expect(deletes).toHaveLength(0);
    // the deal's component list is untouched — no silent bundle shrinkage
    expect((tables.deal_items.find((d) => d.id === "di-1") as Row).product_id).toBe("pt-dealcomp");
    expect((tables.deals.find((d) => d.id === "d-active") as Row).selling_price).toBe(2500);
  });

  it("product in an INACTIVE (historical) deal → still protected", async () => {
    const res = await DELETE(del("pt-inactive-deal"), ctxFor("pt-inactive-deal"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disabled?: boolean; message?: string };
    expect(body.disabled).toBe(true);
    expect(body.message).toContain("deal membership");
    expect(deletes).toHaveLength(0);
  });

  it("deal-only sales history (order_items.product_id is NULL) → disabled via deal membership", async () => {
    // sanity: the bundle line's product_id is NULL, so the old order-count
    // guard would have missed this product entirely
    expect(tables.order_items.filter((r) => r.product_id === "pt-dealonly-sold")).toHaveLength(0);
    const res = await DELETE(del("pt-dealonly-sold"), ctxFor("pt-dealonly-sold"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disabled?: boolean; message?: string };
    expect(body.disabled).toBe(true);
    expect(body.message).toContain("deal membership");
    expect(deletes).toHaveLength(0);
    // historical bundle snapshot keeps its component reference
    const snap = (tables.order_items.find((r) => r.id === "oi-2") as Row).components as Row[];
    expect(snap.some((c) => c.product_id === "pt-dealonly-sold")).toBe(true);
  });

  it("product with only inventory movement history → disabled, ledger preserved", async () => {
    const res = await DELETE(del("pt-moved"), ctxFor("pt-moved"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disabled?: boolean; message?: string };
    expect(body.disabled).toBe(true);
    expect(body.message).toContain("inventory movement history");
    expect(deletes).toHaveLength(0);
    expect(tables.inventory_movements).toHaveLength(2);
  });

  it("product with order history AND deal membership AND movements → disabled with combined reason", async () => {
    const res = await DELETE(del("pt-everything"), ctxFor("pt-everything"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disabled?: boolean; message?: string };
    expect(body.disabled).toBe(true);
    expect(body.message).toContain("order history, deal membership and inventory movement history");
    expect(deletes).toHaveLength(0);
    expect((tables.products.find((p) => p.id === "pt-everything") as Row).status).toBe("inactive");
  });
});

describe("Deal integrity around product disabling", () => {
  it("blocks order-time deal resolution while a component is inactive, restores it after re-enable (PATCH)", async () => {
    const delRes = await DELETE(del("pt-dealcomp"), ctxFor("pt-dealcomp"));
    expect(delRes.status).toBe(200);

    // while disabled: explicit, non-silent rejection (no silent degradation)
    let err: unknown = null;
    try {
      await resolveDealForOrder("d-active", 1);
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect((err as Error).message).toContain("inactive");

    // re-enable via PATCH (admin reactivation path)
    const patchRes = await PATCH(patchJSON({ status: "active" }, "pt-dealcomp"), ctxFor("pt-dealcomp"));
    expect(patchRes.status).toBe(200);

    // deal resolves again with the SAME components and the SAME bundle price
    const deal = await resolveDealForOrder("d-active", 2);
    expect(deal.selling_price).toBe(2500);
    expect(deal.components).toHaveLength(4); // di-1, di-2, di-4, di-5 — full bundle preserved
    expect(deal.components.find((c) => c.product_id === "pt-dealcomp")?.quantity).toBe(2);
  });
});

describe("Demo-mode MemoryStore — FK parity with production", () => {
  // Real MemoryStore (no mocks) with persistence stubbed so the repo's
  // data/demo-store.json is never written by tests. Each test gets a unique
  // id suffix so re-seeded rows never collide across tests.
  const ms = new MemoryStore();
  (ms as unknown as { scheduleSave: () => void }).scheduleSave = () => void 0;

  let run = 0;
  let id: (k: string) => string;
  const insertAll = async (table: string, rows: Row[]) => {
    for (const r of rows) await ms.insert(table as Parameters<typeof ms.insert>[0], r);
  };

  beforeEach(async () => {
    run += 1;
    id = (k: string) => `${k}-${run}`;
    const P = id("pt");
    await insertAll("products", [
      { id: P, name: "Comp A", sku: `A${run}`, status: "active", selling_price: 100, current_stock: 5, reserved_stock: 0, category_id: id("cat"), supplier_id: id("sup") },
      { id: id("pB"), name: "Comp B", sku: `B${run}`, status: "active", selling_price: 200, current_stock: 5, reserved_stock: 0 },
    ]);
    await insertAll("categories", [{ id: id("cat"), name: "Temp Cat" }]);
    await insertAll("suppliers", [{ id: id("sup"), name: "Temp Sup" }]);
    await insertAll("deals", [{ id: id("deal"), name: "Demo Bundle", selling_price: 400, status: "active" }]);
    await insertAll("deal_items", [
      { id: id("diA"), deal_id: id("deal"), product_id: P, quantity: 1 },
      { id: id("diB"), deal_id: id("deal"), product_id: id("pB"), quantity: 2 },
    ]);
    await insertAll("orders", [{ id: id("order"), customer_id: id("cust"), status: "BOOKED", total: 400 }]);
    await insertAll("order_items", [
      { id: id("oi"), order_id: id("order"), product_id: P, product_name: "Comp A", sku: `A${run}`, quantity: 1, unit_price: 100, line_total: 100 },
    ]);
    await insertAll("order_status_history", [{ id: id("osh"), order_id: id("order"), status: "BOOKED" }]);
    await insertAll("shipments", [{ id: id("ship"), order_id: id("order"), tracking_number: `TRK-${run}` }]);
    await insertAll("shipment_tracking", [{ id: id("trk"), order_id: id("order"), shipment_id: id("ship"), status: "BOOKED" }]);
    await insertAll("inventory_movements", [{ id: id("mv"), product_id: P, type: "STOCK_IN", quantity: 5 }]);
    await insertAll("commission_transactions", [{ id: id("comm"), worker_id: id("worker"), order_id: id("order"), type: "DELIVERED_COMMISSION", amount: 40 }]);
    await insertAll("profiles", [{ id: id("worker"), role: "worker", status: "active", name: "Temp Worker" }]);
  });

  it("deleting a product cascades deal_items + inventory_movements and set-nulls order_items", async () => {
    const P = id("pt");
    await ms.delete("products" as Parameters<typeof ms.delete>[0], P);
    expect(await ms.get("deal_items" as Parameters<typeof ms.get>[0], id("diA"))).toBeNull();          // cascade (0009)
    expect(await ms.get("inventory_movements" as Parameters<typeof ms.get>[0], id("mv"))).toBeNull();   // cascade (0001)
    expect(await ms.get("deal_items" as Parameters<typeof ms.get>[0], id("diB"))).not.toBeNull();      // sibling untouched
    const oi = await ms.get("order_items" as Parameters<typeof ms.get>[0], id("oi"));                   // set null, history kept
    expect(oi).not.toBeNull();
    expect(oi?.product_id ?? null).toBeNull();
    expect(await ms.get("deals" as Parameters<typeof ms.get>[0], id("deal"))).not.toBeNull();           // deal itself stays
  });

  it("deleting a deal cascades its deal_items (no orphaned components)", async () => {
    await ms.delete("deals" as Parameters<typeof ms.delete>[0], id("deal"));
    expect(await ms.get("deal_items" as Parameters<typeof ms.get>[0], id("diA"))).toBeNull();
    expect(await ms.get("deal_items" as Parameters<typeof ms.get>[0], id("diB"))).toBeNull();
    expect(await ms.get("products" as Parameters<typeof ms.get>[0], id("pt"))).not.toBeNull();
  });

  it("deleting an order cascades lines/history/shipments/tracking and set-nulls ledger refs", async () => {
    await ms.delete("orders" as Parameters<typeof ms.delete>[0], id("order"));
    expect(await ms.get("order_items" as Parameters<typeof ms.get>[0], id("oi"))).toBeNull();
    expect(await ms.get("order_status_history" as Parameters<typeof ms.get>[0], id("osh"))).toBeNull();
    expect(await ms.get("shipments" as Parameters<typeof ms.get>[0], id("ship"))).toBeNull();
    expect(await ms.get("shipment_tracking" as Parameters<typeof ms.get>[0], id("trk"))).toBeNull(); // grandchild via shipment cascade
    const comm = await ms.get("commission_transactions" as Parameters<typeof ms.get>[0], id("comm"));
    expect(comm).not.toBeNull();
    expect(comm?.order_id ?? null).toBeNull();
  });

  it("deleting a category/supplier set-nulls product references", async () => {
    await ms.delete("categories" as Parameters<typeof ms.delete>[0], id("cat"));
    await ms.delete("suppliers" as Parameters<typeof ms.delete>[0], id("sup"));
    const p = await ms.get("products" as Parameters<typeof ms.get>[0], id("pt"));
    expect(p?.category_id ?? null).toBeNull();
    expect(p?.supplier_id ?? null).toBeNull();
  });

  it("deleting a worker profile set-nulls commission ledger (0003 semantics, not cascade)", async () => {
    await ms.delete("profiles" as Parameters<typeof ms.delete>[0], id("worker"));
    const comm = await ms.get("commission_transactions" as Parameters<typeof ms.get>[0], id("comm"));
    expect(comm).not.toBeNull(); // ledger row survives (append-only history)
    expect(comm?.worker_id ?? null).toBeNull();
  });
});
