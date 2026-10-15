/// <reference types="bun-types" />
/**
 * Deals / bundles (Phase 5) — service, inventory lifecycle and order integration.
 *
 * Covers: deal creation/validation, status lifecycle, delete-vs-archive,
 * order-time snapshots (name/price/components), atomic multi-component
 * reservation (validate-all-then-apply — no partial bundles), delivery
 * deduction, cancellation release, return restore, inactive-deal rejection,
 * worker price safety (bundle price is authoritative) and admin-edit
 * compatibility (bundle lines preserved with their totals).
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";

mock.module("server-only", () => ({}));

type Row = Record<string, unknown>;
let tables: Record<string, Row[]> = {};
const updates: { table: string; id: string; patch: Row }[] = [];
const inserts: { table: string; row: Row }[] = [];
const deletes: { table: string; id: string }[] = [];

function seed() {
  tables = {
    deals: [
      { id: "d1", name: "Spa Bundle", description: null, selling_price: 2500, status: "active", created_by: "u-admin", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
      { id: "d2", name: "Paused Kit", description: null, selling_price: 900, status: "inactive", created_by: "u-admin", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
    ],
    deal_items: [
      { id: "di1", deal_id: "d1", product_id: "p1", quantity: 1 },
      { id: "di2", deal_id: "d1", product_id: "p2", quantity: 2 },
    ],
    products: [
      { id: "p1", name: "Massage Oil", sku: "MO", selling_price: 1200, status: "active", current_stock: 20, reserved_stock: 0 },
      { id: "p2", name: "Serum", sku: "SR", selling_price: 800, status: "active", current_stock: 30, reserved_stock: 0 },
      { id: "p3", name: "Old Cream", sku: "OC", selling_price: 500, status: "inactive", current_stock: 5, reserved_stock: 0 },
    ],
    customers: [{ id: "c1", name: "Ahmed", phone: "03001112222" }],
    profiles: [{ id: "u-w", role: "worker", status: "active", name: "Worker One", commission_rate: 10 }],
    orders: [],
    order_items: [],
    inventory_movements: [],
    order_status_history: [],
  };
}

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
    first: async (table: string, opts?: { filters?: Row }) =>
      (tables[table] ?? []).find((r) => !opts?.filters || Object.entries(opts.filters).every(([k, v]) => r[k] === v)) ?? null,
    update: async (table: string, id: string, patch: Row) => {
      updates.push({ table, id, patch });
      const row = (tables[table] ?? []).find((r) => r.id === id);
      if (row) Object.assign(row, patch);
      return { id, ...patch };
    },
    insert: async (table: string, row: Row) => {
      inserts.push({ table, row });
      const full = { id: `id-${table}-${inserts.length}`, ...row };
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

const auditCalls: { action: string }[] = [];
mock.module("@/lib/services/audit", () => ({
  logAudit: async (args: { action: string }) => {
    auditCalls.push(args);
  },
  notifyAdmins: async () => undefined,
  notifyWorker: async () => undefined,
}));
mock.module("@/lib/services/notifications", () => ({ notifyAdmins: async () => undefined, notifyWorker: async () => undefined }));
mock.module("@/lib/services/whatsapp", () => ({ enqueueWhatsAppOrderEvent: async () => undefined }));
mock.module("@/lib/services/commission", () => ({ processCommissionForStatus: async () => undefined }));

const REAL_DEALS = "../src/lib/services/deals?real";
const { createDeal, updateDeal, deleteDeal, resolveDealForOrder, listDealsWithItems, getDealWithItems, DealError } = await import(REAL_DEALS);
const REAL_ORDERS = "../src/lib/services/orders?real";
const { createOrder, adminUpdateOrder, OrderError } = await import(REAL_ORDERS);
// NOTE: plain path — orders?real imports "./inventory" relative, resolving to
// this same module instance, so InventoryError class identity matches.
const REAL_INVENTORY = "../src/lib/services/inventory";
const { reserveForOrder, finalizeForOrder, releaseForOrder, restoreForOrder, InventoryError } = await import(REAL_INVENTORY);

const admin = { userId: "u-admin", role: "super_admin", name: "Admin" } as never;
const worker = { userId: "u-w", role: "worker", name: "Worker" } as never;

beforeEach(() => {
  seed();
  updates.length = 0;
  inserts.length = 0;
  deletes.length = 0;
  auditCalls.length = 0;
});

describe("deals service — create / update / delete", () => {
  it("creates a deal with validated components and writes an audit entry", async () => {
    const deal = await createDeal(admin, { name: "Ramadan Box", selling_price: 1999, items: [{ product_id: "p1", quantity: 1 }, { product_id: "p2", quantity: 3 }] });
    expect(deal.status).toBe("active");
    const items = tables.deal_items.filter((i) => i.deal_id === deal.id);
    expect(items).toHaveLength(2);
    expect(auditCalls.some((a) => a.action === "deal.created")).toBe(true);
  });

  it("rejects invalid deals: empty components, inactive product, negative price, duplicate product", async () => {
    await expect(createDeal(admin, { name: "X", selling_price: 10, items: [] })).rejects.toBeInstanceOf(DealError);
    await expect(createDeal(admin, { name: "X", selling_price: 10, items: [{ product_id: "p3", quantity: 1 }] })).rejects.toBeInstanceOf(DealError);
    await expect(createDeal(admin, { name: "X", selling_price: -5, items: [{ product_id: "p1", quantity: 1 }] })).rejects.toBeInstanceOf(DealError);
    await expect(createDeal(admin, { name: "X", selling_price: 10, items: [{ product_id: "p1", quantity: 1 }, { product_id: "p1", quantity: 2 }] })).rejects.toBeInstanceOf(DealError);
    expect(tables.deals).toHaveLength(2); // nothing created
  });

  it("deactivates and re-activates via updateDeal", async () => {
    await updateDeal(admin, "d1", { status: "inactive" });
    expect((tables.deals.find((d) => d.id === "d1") as Row).status).toBe("inactive");
    await updateDeal(admin, "d1", { status: "active" });
    expect((tables.deals.find((d) => d.id === "d1") as Row).status).toBe("active");
  });

  it("replaces components on edit (old rows removed)", async () => {
    await updateDeal(admin, "d1", { items: [{ product_id: "p1", quantity: 2 }] });
    const items = tables.deal_items.filter((i) => i.deal_id === "d1");
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(2);
  });

  it("archives a deal that is used by orders instead of deleting it", async () => {
    tables.order_items = [{ id: "oi9", order_id: "o9", deal_id: "d1", product_id: null, product_name: "Spa Bundle", quantity: 1, unit_price: 2500, line_total: 2500 }];
    const result = await deleteDeal(admin, "d1");
    expect(result).toEqual({ deleted: false, archived: true });
    expect((tables.deals.find((d) => d.id === "d1") as Row).status).toBe("archived");
    expect(deletes.filter((d) => d.table === "deals")).toHaveLength(0);
  });

  it("hard-deletes an unused deal", async () => {
    const result = await deleteDeal(admin, "d2");
    expect(result.deleted).toBe(true);
    expect(tables.deals.find((d) => d.id === "d2")).toBeUndefined();
  });
});

describe("deals listing — production 500 regression + empty state", () => {
  it("lists deals with resolved component product data", async () => {
    const rows = await listDealsWithItems();
    expect(rows).toHaveLength(2);
    const d1 = rows.find((d) => d.id === "d1") as Row & { items: Row[] };
    expect(d1.items).toHaveLength(2);
    expect(d1.items.map((i) => i.product_name).sort()).toEqual(["Massage Oil", "Serum"]);
    expect(d1.items.every((i) => typeof i.available_stock === "number")).toBe(true);
  });

  it("returns an EMPTY set on an empty deals table (friendly empty state, no throw)", async () => {
    // Production regression: a fresh Supabase (0009 applied, zero deals) 500-ed
    // on GET /api/deals because the un-ordered deal_items list() defaulted to
    // a created_at order the table does not have. The service contract is:
    // no deals ⇒ { rows: [], total: 0 } — the UI renders "No deals yet".
    tables.deals = [];
    tables.deal_items = [];
    const rows = await listDealsWithItems();
    expect(rows).toEqual([]);
  });

  it("returns an empty set even when deal_items exist but no deals match", async () => {
    tables.deals = [];
    const rows = await listDealsWithItems();
    expect(rows).toEqual([]); // orphan-free: items without a parent deal never surface
  });

  it("status filter narrows the list without dropping resolved items", async () => {
    const rows = await listDealsWithItems({ statuses: ["active"] });
    expect(rows).toHaveLength(1);
    expect((rows[0] as Row).id).toBe("d1");
    expect((rows[0] as Row & { items: Row[] }).items).toHaveLength(2);
  });

  it("getDealWithItems returns null for a missing deal (no throw)", async () => {
    expect(await getDealWithItems("does-not-exist")).toBeNull();
  });
});

describe("resolveDealForOrder — order-time snapshot", () => {
  it("expands components × line quantity", async () => {
    const snap = await resolveDealForOrder("d1", 2);
    expect(snap.name).toBe("Spa Bundle");
    expect(snap.selling_price).toBe(2500);
    expect(snap.components).toEqual([
      { product_id: "p1", name: "Massage Oil", quantity: 2 },
      { product_id: "p2", name: "Serum", quantity: 4 },
    ]);
  });

  it("refuses inactive deals for new orders", async () => {
    await expect(resolveDealForOrder("d2", 1)).rejects.toBeInstanceOf(DealError);
  });
});

describe("orders with deals — snapshots, reservation, lifecycle", () => {
  it("creates an order line with deal snapshots and reserves EVERY component (worker path)", async () => {
    const order = await createOrder(worker, {
      customer: { id: "c1" },
      items: [{ deal_id: "d1", quantity: 2, unit_price: 1 }],
      discount: 0,
      delivery_address: "Test Street 1",
      city: "Okara",
    });
    // bundle price is authoritative — the client's unit_price: 1 is ignored
    expect(order.subtotal).toBe(5000); // 2 × 2500
    expect(order.cod_amount).toBe(5000); // worker path pins COD to the total
    const line = tables.order_items[0] as Row;
    expect(line.deal_id).toBe("d1");
    expect(line.product_id).toBeNull();
    expect(line.product_name).toBe("Spa Bundle");
    expect(line.unit_price).toBe(2500);
    expect(line.line_total).toBe(5000);
    expect(line.components).toEqual([
      { product_id: "p1", name: "Massage Oil", quantity: 2 },
      { product_id: "p2", name: "Serum", quantity: 4 },
    ]);
    // reservations: p1 +2, p2 +4
    expect((tables.products.find((p) => p.id === "p1") as Row).reserved_stock).toBe(2);
    expect((tables.products.find((p) => p.id === "p2") as Row).reserved_stock).toBe(4);
  });

  it("fails the WHOLE order when any component is short — no partial reservation", async () => {
    // p1 has only 20 on hand: a 25-bundle needs 25 → must fail before any write
    let error: unknown = null;
    try {
      await createOrder(worker, {
        customer: { id: "c1" },
        items: [{ deal_id: "d1", quantity: 25 }],
        discount: 0,
        delivery_address: "Test Street 1",
        city: "Okara",
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(InventoryError);
    expect((error as Error).message).toContain("Massage Oil");
    // nothing reserved, no order row, no order_items, no movements
    expect((tables.products.find((p) => p.id === "p1") as Row).reserved_stock).toBe(0);
    expect((tables.products.find((p) => p.id === "p2") as Row).reserved_stock).toBe(0);
    expect(tables.orders).toHaveLength(0);
    expect(tables.order_items).toHaveLength(0);
    expect(tables.inventory_movements).toHaveLength(0);
  });

  it("deducts exactly once on delivery (bundle expansion)", async () => {
    const order = await createOrder(admin, {
      customer: { id: "c1" },
      items: [{ deal_id: "d1", quantity: 1 }],
      discount: 0,
      delivery_address: "Test Street 1",
      city: "Okara",
    });
    await finalizeForOrder(order.id, order.order_number, "u-admin");
    const p1 = tables.products.find((p) => p.id === "p1") as Row;
    const p2 = tables.products.find((p) => p.id === "p2") as Row;
    expect(p1.current_stock).toBe(19); // 20 − 1
    expect(p1.reserved_stock).toBe(0);
    expect(p2.current_stock).toBe(28); // 30 − 2
    expect(p2.reserved_stock).toBe(0);
  });

  it("releases all components on cancellation and restores them on post-delivery return", async () => {
    const order = await createOrder(admin, {
      customer: { id: "c1" },
      items: [{ deal_id: "d1", quantity: 1 }],
      discount: 0,
      delivery_address: "Test Street 1",
      city: "Okara",
    });
    await releaseForOrder(order.id, order.order_number, "u-admin"); // cancel path
    expect((tables.products.find((p) => p.id === "p1") as Row).reserved_stock).toBe(0);
    expect((tables.products.find((p) => p.id === "p2") as Row).reserved_stock).toBe(0);

    // re-create, deliver, then return → components restored to stock
    const order2 = await createOrder(admin, {
      customer: { id: "c1" },
      items: [{ deal_id: "d1", quantity: 1 }],
      discount: 0,
      delivery_address: "Test Street 1",
      city: "Okara",
    });
    await finalizeForOrder(order2.id, order2.order_number, "u-admin");
    await restoreForOrder(order2.id, order2.order_number, "u-admin");
    expect((tables.products.find((p) => p.id === "p1") as Row).current_stock).toBe(20);
    expect((tables.products.find((p) => p.id === "p2") as Row).current_stock).toBe(30);
  });

  it("keeps bundle lines and their totals when an admin edits the order's regular lines", async () => {
    const order = await createOrder(admin, {
      customer: { id: "c1" },
      items: [
        { deal_id: "d1", quantity: 1 },
        { product_id: "p1", quantity: 1, unit_price: 1200 },
      ],
      discount: 0,
      delivery_address: "Test Street 1",
      city: "Okara",
    });
    // subtotal = 2500 (bundle) + 1200 (product) = 3700
    expect(order.subtotal).toBe(3700);
    // admin reduces the regular product line to 2 units at 600
    const updated = await adminUpdateOrder(admin, order.id, {
      items: [{ product_id: "p1", quantity: 2, unit_price: 600 }],
    });
    // bundle line preserved verbatim + regular line = 2500 + 1200 = 3700
    expect(updated.subtotal).toBe(3700);
    expect(updated.total).toBe(3700);
    const lines = tables.order_items as Row[];
    expect(lines).toHaveLength(2);
    const bundle = lines.find((l) => l.deal_id === "d1") as Row;
    expect(bundle.line_total).toBe(2500); // untouched
    // reservations: p1 = 1 (bundle) + 2 (regular) = 3, p2 = 2
    expect((tables.products.find((p) => p.id === "p1") as Row).reserved_stock).toBe(3);
    expect((tables.products.find((p) => p.id === "p2") as Row).reserved_stock).toBe(2);
  });
});
