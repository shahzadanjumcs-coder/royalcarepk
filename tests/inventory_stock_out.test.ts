/// <reference types="bun-types" />
/**
 * Stock Out regression tests (Phase 2).
 *
 * Root cause already fixed in the tree (stock-out page passes
 * quantitySign={-1} / quantityFixedPositive={false}): the UI used to send
 * +N for STOCK_OUT and the API rejected it with "Enter the amount going out
 * as a negative number, or use Stock In." — so admin Stock Out never worked.
 *
 * These tests lock in the full chain contract:
 *   - UI fix present in src/app/admin/inventory/stock-out/page.tsx
 *   - POST /api/inventory/movement accepts a NEGATIVE quantity for STOCK_OUT
 *     and still rejects non-negative ones (422, zero side effects)
 *   - applyMovement deducts current_stock only — reserved_stock is preserved
 *   - insufficient stock is refused with NO partial modification
 *   - order reservation/delivery lifecycle is untouched by manual stock-outs
 *     (no double deduction)
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";

mock.module("server-only", () => ({}));

type Row = Record<string, unknown>;
let tables: Record<string, Row[]> = {};
const updates: { table: string; id: string; patch: Row }[] = [];
const inserts: { table: string; row: Row }[] = [];

function seedProducts(rows: Row[]) {
  tables = { products: rows, inventory_movements: [] };
}

mock.module("@/lib/auth/session", () => ({
  getSession: async () => ({ userId: "u-admin", email: "a@rc.pk", name: "Admin", role: "admin", mode: "supabase" }),
}));
mock.module("@/lib/services/audit", () => ({ logAudit: async () => undefined }));
mock.module("@/lib/services/notifications", () => ({ notifyAdmins: async () => undefined }));
mock.module("@/lib/store", () => ({
  IS_DEMO_MODE: false,
  store: {
    get: async (table: string, id: string) => (tables[table] ?? []).find((r) => r.id === id) ?? null,
    update: async (table: string, id: string, patch: Row) => {
      updates.push({ table, id, patch });
      const row = (tables[table] ?? []).find((r) => r.id === id);
      if (row) Object.assign(row, patch);
      return { id, ...patch };
    },
    insert: async (table: string, row: Row) => {
      inserts.push({ table, row });
      const full = { id: `id-${inserts.length}`, ...row };
      tables[table] = [...(tables[table] ?? []), full];
      return full;
    },
    list: async (table: string, opts?: { filters?: Row }) => {
      let rows = tables[table] ?? [];
      const f = opts?.filters;
      if (f) rows = rows.filter((r) => Object.entries(f).every(([k, v]) => r[k] === v));
      return { rows, total: rows.length };
    },
  },
}));

// Distinct module key: this file mocks "@/lib/store" globally; the query
// string gives the service a fresh evaluation that still hits OUR store mock
// (same pattern as tests/flaship_booking_orders.test.ts).
const REAL_INVENTORY = "../src/lib/services/inventory?real";
const { applyMovement, InventoryError, reserveForOrder, finalizeForOrder } = await import(REAL_INVENTORY);
const { POST } = await import("../src/app/api/inventory/movement/route");

beforeEach(() => {
  updates.length = 0;
  inserts.length = 0;
  seedProducts([{ id: "p1", name: "Serum", current_stock: 10, reserved_stock: 4, min_stock: 2 }]);
});

const postJSON = (payload: unknown) =>
  new Request("http://x/api/inventory/movement", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
  });

describe("applyMovement — STOCK_OUT semantics", () => {
  it("deducts current stock and leaves reserved stock untouched", async () => {
    await applyMovement({ productId: "p1", type: "STOCK_OUT", quantity: -3, userId: "u-admin" });
    const p = tables.products[0] as Row;
    expect(p.current_stock).toBe(7); // 10 − 3
    expect(p.reserved_stock).toBe(4); // preserved
    const ledger = inserts.find((i) => i.table === "inventory_movements");
    expect(ledger).toBeDefined();
    expect(ledger!.row.quantity).toBe(-3); // signed, matches the actual change
    expect(ledger!.row.balance_after).toBe(7);
    expect(ledger!.row.reserved_after).toBe(4);
  });

  it("normalizes a positive input to a deduction at the service layer (-Math.abs)", async () => {
    // Service-level normalization; the API layer rejects positive STOCK_OUT
    // before reaching this (see route test below).
    await applyMovement({ productId: "p1", type: "STOCK_OUT", quantity: 3 });
    expect((tables.products[0] as Row).current_stock).toBe(7);
  });

  it("refuses a movement that would take stock below zero with ZERO side effects", async () => {
    let error: unknown = null;
    try {
      await applyMovement({ productId: "p1", type: "STOCK_OUT", quantity: -11 }); // current 10
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(InventoryError);
    expect((error as Error).message).toContain("Insufficient stock");
    expect(updates).toHaveLength(0); // no partial modification
    expect(inserts).toHaveLength(0); // no ledger row for a refused movement
  });

  it("coexists with the order reservation/delivery lifecycle (no double deduction)", async () => {
    // reserve 2 for an order → delivery finalizes; a manual stock-out in
    // between must not touch the reservation.
    tables.order_items = [{ product_id: "p1", quantity: 2, order_id: "o1" }];
    await reserveForOrder([{ product_id: "p1", quantity: 2 }], "o1", "RC-1", "u-admin");
    expect((tables.products[0] as Row).reserved_stock).toBe(6); // 4 + 2
    await applyMovement({ productId: "p1", type: "STOCK_OUT", quantity: -3 });
    expect((tables.products[0] as Row).current_stock).toBe(7);
    expect((tables.products[0] as Row).reserved_stock).toBe(6);
    await finalizeForOrder("o1", "RC-1", "u-admin"); // DELIVERY: −current −reserved
    const p = tables.products[0] as Row;
    expect(p.current_stock).toBe(5); // 7 − 2
    expect(p.reserved_stock).toBe(4); // 6 − 2 (back to the other order's reservation)
  });
});

describe("POST /api/inventory/movement — Stock Out contract", () => {
  it("records a valid Stock Out sent as a negative quantity (the fixed UI path)", async () => {
    const res = await POST(postJSON({ product_id: "p1", type: "STOCK_OUT", quantity: -5, note: "Damaged" }));
    expect(res.status).toBe(201);
    expect((tables.products[0] as Row).current_stock).toBe(5);
    expect((tables.products[0] as Row).reserved_stock).toBe(4);
    expect(inserts.some((i) => i.table === "inventory_movements")).toBe(true);
  });

  it("rejects a POSITIVE Stock Out quantity with a clear error and no side effects", async () => {
    const res = await POST(postJSON({ product_id: "p1", type: "STOCK_OUT", quantity: 5 }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toContain("negative number");
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("rejects a zero quantity (zod) and an insufficient Stock Out (service) with no partial writes", async () => {
    const zero = await POST(postJSON({ product_id: "p1", type: "STOCK_OUT", quantity: 0 }));
    expect(zero.status).toBe(422);

    const tooMuch = await POST(postJSON({ product_id: "p1", type: "STOCK_OUT", quantity: -50 }));
    expect(tooMuch.status).toBe(422);
    expect(((await tooMuch.json()) as { error: string }).error).toContain("Insufficient stock");
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("keeps the Stock In path working (positive quantity required)", async () => {
    const res = await POST(postJSON({ product_id: "p1", type: "STOCK_IN", quantity: 5 }));
    expect(res.status).toBe(201);
    expect((tables.products[0] as Row).current_stock).toBe(15);

    const bad = await POST(postJSON({ product_id: "p1", type: "STOCK_IN", quantity: -5 }));
    expect(bad.status).toBe(422);
  });
});

describe("Stock Out page — UI fix present", () => {
  it("stock-out page passes quantitySign={-1} and quantityFixedPositive={false}", async () => {
    const fs = await import("node:fs");
    const path = "src/app/admin/inventory/stock-out/page.tsx";
    const src = await fs.promises.readFile(path, "utf8");
    expect(src).toContain('type="STOCK_OUT"');
    expect(src).toContain("quantitySign={-1}");
    expect(src).toContain("quantityFixedPositive={false}");
  });
});
