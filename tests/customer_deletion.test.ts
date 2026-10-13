/// <reference types="bun-types" />
/**
 * Customer deletion / archive safety (Phase 4).
 *
 * DELETE /api/customers/[id] contract:
 *   - admin/super_admin only (workers and inventory_manager → 403)
 *   - customer WITH order history → never deleted: soft-disabled
 *     (order/payment/commission/shipment history stays intact)
 *   - customer WITHOUT orders → hard delete (no FK risk: orders.customer_id
 *     is ON DELETE RESTRICT and the app checks the count first)
 * PATCH restores a disabled customer to active.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";

type Row = Record<string, unknown>;
let tables: Record<string, Row[]> = {};
const updates: { table: string; id: string; patch: Row }[] = [];
const deletes: { table: string; id: string }[] = [];

function seed() {
  tables = {
    customers: [
      { id: "c-old", name: "Old Buyer", phone: "03001110000", status: "active" },
      { id: "c-new", name: "Fresh Lead", phone: "03002220000", status: "active" },
      { id: "c-dis", name: "Archived One", phone: "03003330000", status: "disabled" },
    ],
    orders: [{ id: "o1", customer_id: "c-old", status: "DELIVERED", total: 1200 }],
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

const { DELETE, PATCH } = await import("../src/app/api/customers/[id]/route");

beforeEach(() => {
  seed();
  updates.length = 0;
  deletes.length = 0;
  mockSession = { userId: "u-admin", email: "a@rc.pk", name: "Admin", role: "admin", mode: "supabase" };
});

const del = (id: string) =>
  new Request(`http://x/api/customers/${id}`, { method: "DELETE" });
const ctxFor = (id: string) => ({ params: Promise.resolve({ id }) });
const patchJSON = (payload: unknown, id: string) =>
  new Request(`http://x/api/customers/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
  });

describe("DELETE /api/customers/[id]", () => {
  it("rejects workers and inventory managers (403)", async () => {
    mockSession = { userId: "u-w", email: "w@rc.pk", name: "W", role: "worker", mode: "supabase" };
    const res1 = await DELETE(del("c-new"), ctxFor("c-new"));
    expect(res1.status).toBe(403);

    mockSession = { userId: "u-im", email: "im@rc.pk", name: "IM", role: "inventory_manager", mode: "supabase" };
    const res2 = await DELETE(del("c-new"), ctxFor("c-new"));
    expect(res2.status).toBe(403);
    expect(deletes).toHaveLength(0);
  });

  it("hard-deletes a customer with NO order history", async () => {
    const res = await DELETE(del("c-new"), ctxFor("c-new"));
    expect(res.status).toBe(200);
    expect(deletes.some((d) => d.table === "customers" && d.id === "c-new")).toBe(true);
    expect(updates).toHaveLength(0);
  });

  it("never deletes a customer WITH order history — archives instead (FK + history safety)", async () => {
    const res = await DELETE(del("c-old"), ctxFor("c-old"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disabled?: boolean; message?: string };
    expect(body.disabled).toBe(true);
    expect(body.message).toContain("disabled instead of deleted");
    // the customer row was UPDATED to disabled, never removed
    expect(deletes).toHaveLength(0);
    expect(updates.some((u) => u.table === "customers" && u.id === "c-old" && u.patch.status === "disabled")).toBe(true);
    expect((tables.customers.find((c) => c.id === "c-old") as Row).status).toBe("disabled");
  });

  it("returns 404 for an unknown customer", async () => {
    const res = await DELETE(del("c-missing"), ctxFor("c-missing"));
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/customers/[id] — restore", () => {
  it("restores a disabled customer to active", async () => {
    const res = await PATCH(patchJSON({ status: "active" }, "c-dis"), ctxFor("c-dis"));
    expect(res.status).toBe(200);
    expect(updates.some((u) => u.id === "c-dis" && u.patch.status === "active")).toBe(true);
    expect((tables.customers.find((c) => c.id === "c-dis") as Row).status).toBe("active");
  });
});
