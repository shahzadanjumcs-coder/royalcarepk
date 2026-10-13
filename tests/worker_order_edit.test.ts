/// <reference types="bun-types" />
/**
 * Phase 6 — worker self-service delivery editing before booking.
 *
 * Workers may correct ONLY delivery_address / city / notes on their OWN
 * unbooked orders. Ownership, field allow-list, booked/closed immutability
 * and admin-path regression are covered; the booking payload test
 * (uses the LATEST saved address) lives in flaship_booking_orders.test.ts.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";

mock.module("server-only", () => ({}));

type Row = Record<string, unknown>;
let tables: Record<string, Row[]> = {};
const updates: { table: string; id: string; patch: Row }[] = [];
const auditCalls: { action: string }[] = [];

function seed() {
  tables = {
    orders: [
      {
        id: "o1",
        order_number: "RC-3001",
        customer_id: "c1",
        worker_id: "u-w1",
        status: "PENDING",
        approval_status: "APPROVED",
        subtotal: 1000,
        discount: 0,
        total: 1000,
        cod_amount: 1000,
        delivery_address: "Old Street 1",
        city: "Okara",
        notes: null,
        booking_status: "not_booked",
        tracking_number: null,
      },
    ],
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
    first: async () => null,
    update: async (table: string, id: string, patch: Row) => {
      updates.push({ table, id, patch });
      const row = (tables[table] ?? []).find((r) => r.id === id);
      if (row) Object.assign(row, patch);
      return { id, ...patch };
    },
    insert: async (table: string, row: Row) => {
      const full = { id: `id-${table}-${updates.length}`, ...row };
      tables[table] = [...(tables[table] ?? []), full];
      return full;
    },
    delete: async () => {},
    count: async () => 0,
  },
}));

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
mock.module("@/lib/services/inventory", () => ({
  reserveForOrder: async () => undefined,
  finalizeForOrder: async () => undefined,
  restoreForOrder: async () => undefined,
  releaseForOrder: async () => undefined,
  applyMovement: async () => undefined,
}));

let mockSession: { userId: string; email: string; name: string; role: string; mode: string } | null = {
  userId: "u-w1",
  email: "w@rc.pk",
  name: "Worker One",
  role: "worker",
  mode: "supabase",
};
mock.module("@/lib/auth/session", () => ({ getSession: async () => mockSession }));

const { PATCH } = await import("../src/app/api/orders/[id]/route");

beforeEach(() => {
  seed();
  updates.length = 0;
  auditCalls.length = 0;
  mockSession = { userId: "u-w1", email: "w@rc.pk", name: "Worker One", role: "worker", mode: "supabase" };
});

const patchJSON = (payload: unknown) =>
  new Request("http://x/api/orders/o1", {
    method: "PATCH",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
  });
const ctx = { params: Promise.resolve({ id: "o1" }) };

describe("PATCH /api/orders/[id] — worker delivery edits (Phase 6)", () => {
  it("worker corrects the address/city of their OWN unbooked order", async () => {
    const res = await PATCH(patchJSON({ delivery_address: "New Town 9", city: "Lahore", notes: "Ring twice" }), ctx);
    expect(res.status).toBe(200);
    const order = tables.orders[0] as Row;
    expect(order.delivery_address).toBe("New Town 9");
    expect(order.city).toBe("Lahore");
    expect(order.notes).toBe("Ring twice");
    expect(auditCalls.some((a) => a.action === "order.delivery_edited")).toBe(true);
  });

  it("worker cannot edit ANOTHER worker's order", async () => {
    mockSession = { userId: "u-w2", email: "w2@rc.pk", name: "Worker Two", role: "worker", mode: "supabase" };
    const res = await PATCH(patchJSON({ delivery_address: "Hacked 1" }), ctx);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toContain("do not have access");
    expect(updates).toHaveLength(0);
  });

  it("worker cannot smuggle price/item/customer fields (403, nothing written)", async () => {
    const res = await PATCH(patchJSON({ delivery_address: "X", unit_price: 1, items: [{ product_id: "p", quantity: 1 }], customer_id: "c2", cod_amount: 0 }), ctx);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("only edit the delivery address");
    expect(updates).toHaveLength(0);
  });

  it("worker cannot edit a booked order — points to admin cancel-and-rebook", async () => {
    tables.orders = [{ ...(tables.orders[0] as Row), tracking_number: "CN-9", booking_status: "booked" }];
    const res = await PATCH(patchJSON({ delivery_address: "Late Change" }), ctx);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("already booked");
    expect(body.error).toContain("cancel and rebook");
    expect(updates).toHaveLength(0);
  });

  it("worker cannot edit a closed order", async () => {
    tables.orders = [{ ...(tables.orders[0] as Row), status: "DELIVERED" }];
    const res = await PATCH(patchJSON({ delivery_address: "X" }), ctx);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toContain("Closed orders");
  });

  it("admin path still works through the widened gate (regression)", async () => {
    mockSession = { userId: "u-admin", email: "a@rc.pk", name: "Admin", role: "admin", mode: "supabase" };
    const res = await PATCH(patchJSON({ delivery_address: "Admin Edited 5", city: "Karachi" }), ctx);
    expect(res.status).toBe(200);
    const order = tables.orders[0] as Row;
    expect(order.delivery_address).toBe("Admin Edited 5");
    expect(order.city).toBe("Karachi");
  });
});
