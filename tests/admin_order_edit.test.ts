/// <reference types="bun-types" />
/**
 * Admin order editing (Phase 3) — service + route regressions.
 *
 * Covers: worker-created orders edited by admins before booking, price
 * increases/decreases, address changes, quantity changes, stock reservation
 * diffs (release-then-reserve, validate-first), restricted status
 * transitions (closed/booked orders), server-authoritative totals
 * (no client total is trusted), item price snapshots and audit history.
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
    orders: [
      {
        id: "o1",
        order_number: "RC-2001",
        customer_id: "c1",
        worker_id: "w1",
        status: "PENDING",
        approval_status: "PENDING",
        subtotal: 1000,
        discount: 0,
        total: 1000,
        cod_amount: 1000,
        delivery_address: "Old Street 1",
        city: "Okara",
        notes: null,
        commission_rate: 10,
        booking_status: "not_booked",
        tracking_number: null,
      },
    ],
    order_items: [
      { id: "oi1", order_id: "o1", product_id: "p1", product_name: "Serum", sku: "SR", quantity: 2, unit_price: 500, line_total: 1000 },
    ],
    products: [
      { id: "p1", name: "Serum", sku: "SR", selling_price: 500, status: "active", current_stock: 20, reserved_stock: 2 },
      { id: "p2", name: "Cream", sku: "CR", selling_price: 300, status: "active", current_stock: 3, reserved_stock: 0 },
    ],
    customers: [
      { id: "c1", name: "Ahmed", phone: "03001112222" },
      { id: "c2", name: "Bilal", phone: "03003334444" },
    ],
    inventory_movements: [],
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
    count: async () => 0,
  },
}));

const auditCalls: { action: string; entity?: string }[] = [];
mock.module("@/lib/services/audit", () => ({
  logAudit: async (args: { action: string; entity?: string }) => {
    auditCalls.push(args);
  },
  notifyAdmins: async () => undefined,
}));
mock.module("@/lib/services/notifications", () => ({ notifyAdmins: async () => undefined, notifyWorker: async () => undefined }));
mock.module("@/lib/services/whatsapp", () => ({ enqueueWhatsAppOrderEvent: async () => undefined }));

const REAL_ORDERS = "../src/lib/services/orders?real";
const { adminUpdateOrder, OrderError } = await import(REAL_ORDERS);

// ---- route-level tests (authorization + zod) ----
let mockSession: { userId: string; email: string; name: string; role: string; mode: string } | null = {
  userId: "u-admin",
  email: "a@rc.pk",
  name: "Admin",
  role: "admin",
  mode: "supabase",
};
mock.module("@/lib/auth/session", () => ({ getSession: async () => mockSession }));
const { PATCH } = await import("../src/app/api/orders/[id]/route");

beforeEach(() => {
  seed();
  updates.length = 0;
  inserts.length = 0;
  deletes.length = 0;
  auditCalls.length = 0;
  mockSession = { userId: "u-admin", email: "a@rc.pk", name: "Admin", role: "admin", mode: "supabase" };
});

const patchJSON = (payload: unknown) =>
  new Request("http://x/api/orders/o1", {
    method: "PATCH",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
  });
const ctx = { params: Promise.resolve({ id: "o1" }) };

describe("adminUpdateOrder — pre-booking edits", () => {
  it("recalculates totals server-side, rewrites price snapshots and reserves the extra quantity", async () => {
    const order = await adminUpdateOrder({ userId: "u-admin" } as never, "o1", {
      items: [{ product_id: "p1", quantity: 3, unit_price: 400 }],
    });
    expect(order.subtotal).toBe(1200);
    expect(order.total).toBe(1200);
    expect(order.cod_amount).toBe(1200); // defaults to the new total
    // snapshot rewritten (old row deleted, new row inserted)
    expect(deletes.some((d) => d.table === "order_items" && d.id === "oi1")).toBe(true);
    const newItem = inserts.find((i) => i.table === "order_items")!.row;
    expect(newItem.product_name).toBe("Serum");
    expect(newItem.unit_price).toBe(400);
    expect(newItem.line_total).toBe(1200);
    // reservation diff: +1
    expect((tables.products[0] as Row).reserved_stock).toBe(3);
    const movement = inserts.find((i) => i.table === "inventory_movements")!.row;
    expect(movement.type).toBe("ORDER_RESERVE");
    expect(movement.quantity).toBe(0); // reserve only moves reserved_stock…
    expect(movement.reserved_change).toBe(1);
    // audit history
    expect(auditCalls.some((a) => a.action === "order.admin_edited")).toBe(true);
  });

  it("releases reservations when quantities decrease", async () => {
    await adminUpdateOrder({ userId: "u-admin" } as never, "o1", {
      items: [{ product_id: "p1", quantity: 1, unit_price: 600 }],
    });
    const p1 = tables.products[0] as Row;
    expect(p1.reserved_stock).toBe(1); // 2 − 1
    expect((tables.orders[0] as Row).total).toBe(600);
  });

  it("swaps a product: releases the old reservation and reserves the new product", async () => {
    await adminUpdateOrder({ userId: "u-admin" } as never, "o1", {
      items: [{ product_id: "p2", quantity: 1 }],
    });
    expect((tables.products[0] as Row).reserved_stock).toBe(0); // p1 fully released
    expect((tables.products[1] as Row).reserved_stock).toBe(1); // p2 reserved
    const newItem = inserts.find((i) => i.table === "order_items")!.row;
    expect(newItem.product_name).toBe("Cream");
    expect(newItem.unit_price).toBe(300); // catalogue price default
  });

  it("keeps the existing item price when the product is unchanged and no price is sent", async () => {
    await adminUpdateOrder({ userId: "u-admin" } as never, "o1", {
      items: [{ product_id: "p1", quantity: 2 }], // no unit_price
    });
    const newItem = inserts.find((i) => i.table === "order_items")!.row;
    expect(newItem.unit_price).toBe(500); // order-time price preserved
  });

  it("refuses an increase beyond available stock with ZERO partial modifications", async () => {
    // p2 has 3 on hand, 0 reserved → increase of 5 impossible
    let error: unknown = null;
    try {
      await adminUpdateOrder({ userId: "u-admin" } as never, "o1", {
        items: [
          { product_id: "p1", quantity: 2 },
          { product_id: "p2", quantity: 5 },
        ],
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(OrderError);
    expect((error as Error).message).toContain("Not enough available stock");
    // nothing was touched: no order update, no item rewrite, no movements
    expect(updates).toHaveLength(0);
    expect(deletes).toHaveLength(0);
    expect(inserts).toHaveLength(0);
    expect((tables.products[1] as Row).reserved_stock).toBe(0);
    expect((tables.orders[0] as Row).total).toBe(1000);
  });

  it("changes the delivery address, city, customer and notes before booking", async () => {
    const order = await adminUpdateOrder({ userId: "u-admin" } as never, "o1", {
      customer_id: "c2",
      delivery_address: "New Town 9",
      city: "Lahore",
      notes: "Ring twice",
    });
    expect(order.customer_id).toBe("c2");
    expect(order.delivery_address).toBe("New Town 9");
    expect(order.city).toBe("Lahore");
    expect(order.notes).toBe("Ring twice");
    // pricing untouched by an address-only edit
    expect(order.total).toBe(1000);
  });

  it("keeps a PENDING worker order PENDING after an admin edit", async () => {
    await adminUpdateOrder({ userId: "u-admin" } as never, "o1", { delivery_address: "Addr 2" });
    expect((tables.orders[0] as Row).approval_status).toBe("PENDING");
    expect((tables.orders[0] as Row).submitted_at ?? null).toBeNull();
  });

  it("validates discount bounds and negative prices", async () => {
    let e1: unknown = null;
    try {
      await adminUpdateOrder({ userId: "u-admin" } as never, "o1", { discount: 2000 });
    } catch (e) {
      e1 = e;
    }
    expect((e1 as Error).message).toContain("cannot exceed");
    expect(updates).toHaveLength(0);

    let e2: unknown = null;
    try {
      await adminUpdateOrder({ userId: "u-admin" } as never, "o1", {
        items: [{ product_id: "p1", quantity: 1, unit_price: -5 }],
      });
    } catch (e) {
      e2 = e;
    }
    expect((e2 as Error).message).toContain("negative");
    expect(updates).toHaveLength(0);
  });
});

describe("adminUpdateOrder — restricted states", () => {
  it("blocks item/price/address edits on a BOOKED order and explains cancel-and-rebook", async () => {
    tables.orders = [{ ...(tables.orders[0] as Row), tracking_number: "CN-777", booking_status: "booked" }];
    let error: unknown = null;
    try {
      await adminUpdateOrder({ userId: "u-admin" } as never, "o1", { delivery_address: "Changed" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(OrderError);
    const msg = (error as Error).message;
    expect(msg).toContain("already booked");
    expect(msg).toContain("cancel the order and create a corrected rebooking");
    expect(updates).toHaveLength(0);
  });

  it("allows notes-only edits on a booked order (internal record, not courier data)", async () => {
    tables.orders = [{ ...(tables.orders[0] as Row), tracking_number: "CN-777", booking_status: "booked" }];
    const order = await adminUpdateOrder({ userId: "u-admin" } as never, "o1", { notes: "Customer called — deliver after 5pm" });
    expect(order.notes).toBe("Customer called — deliver after 5pm");
    expect(order.tracking_number).toBe("CN-777");
  });

  it("never edits closed orders (commission/stock history stays final)", async () => {
    tables.orders = [{ ...(tables.orders[0] as Row), status: "DELIVERED" }];
    let error: unknown = null;
    try {
      await adminUpdateOrder({ userId: "u-admin" } as never, "o1", { delivery_address: "X" });
    } catch (e) {
      error = e;
    }
    expect((error as Error).message).toContain("Closed orders cannot be edited");
  });
});

describe("PATCH /api/orders/[id] — route authorization & validation", () => {
  it("limits workers to delivery-field edits (admin-only fields → 403) — Phase 6 contract", async () => {
    // Since Phase 6 workers may PATCH their own orders' delivery fields; the
    // admin-only subset must still be refused at the gate.
    mockSession = { userId: "u-w", email: "w@rc.pk", name: "Worker", role: "worker", mode: "supabase" };
    const res = await PATCH(patchJSON({ cod_amount: 5, items: [{ product_id: "p1", quantity: 1 }] }), ctx);
    expect(res.status).toBe(403);
  });

  it("accepts a valid admin edit and returns the recalculated order", async () => {
    const res = await PATCH(patchJSON({ items: [{ product_id: "p1", quantity: 3, unit_price: 400 }] }), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { order: Row };
    expect(body.order.total).toBe(1200);
  });

  it("rejects invalid payloads (422) without partial writes", async () => {
    const res = await PATCH(patchJSON({ items: [{ product_id: "p1", quantity: 0 }] }), ctx);
    expect(res.status).toBe(422);
    expect(updates).toHaveLength(0);
  });
});
