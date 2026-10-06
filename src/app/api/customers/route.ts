import { ok, fail, withAuth, parseListParams, GENERIC_ERROR } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import { z } from "zod";
import { isValidPhone } from "@/lib/utils";
import { logAudit } from "@/lib/services/audit";
import type { Customer } from "@/lib/types";

// Staff-only: returns FULL customer rows (email, notes, address). The worker
// order form must use /api/lookup, whose worker branch returns only the
// name/phone/city/address subset (see lookup/route.ts).
export const GET = withAuth(["super_admin", "admin", "inventory_manager"], async (session, req) => {
  const url = new URL(req.url);
  const opts = parseListParams(url, "created_at", ["name", "phone", "email", "city"]);
  const { rows, total } = await store.list<Customer>("customers", opts);
  const { rows: orders } = await store.list<{ customer_id: string; status: string; total: number }>("orders");
  const enriched = rows.map((c) => {
    const own = session.role === "worker" ? [] : orders.filter((o) => o.customer_id === c.id);
    return {
      ...c,
      total_orders: own.length,
      delivered_orders: own.filter((o) => o.status === "DELIVERED").length,
      returned_orders: own.filter((o) => o.status === "RETURNED").length,
      total_spending: own.filter((o) => o.status === "DELIVERED").reduce((s, o) => s + o.total, 0),
    };
  });
  return ok({ rows: enriched, total, page: opts.page, perPage: opts.perPage });
});

export const POST = withAuth(["super_admin", "admin"], async (session, req) => {
  try {
    const schema = z.object({
      name: z.string().min(1, "Customer name is required."),
      phone: z.string().refine(isValidPhone, "A valid phone number is required."),
      email: z.string().email().optional().or(z.literal("")),
      address: z.string().optional(),
      city: z.string().optional(),
      notes: z.string().optional(),
    });
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid data.", 422);
    const dup = await store.first("customers", { phone: parsed.data.phone });
    if (dup) return fail("A customer with this phone number already exists.", 409);
    const customer = await store.insert("customers", {
      name: parsed.data.name,
      phone: parsed.data.phone,
      email: parsed.data.email || null,
      address: parsed.data.address || null,
      city: parsed.data.city || null,
      notes: parsed.data.notes || null,
      status: "active",
    });
    await logAudit({ session, action: "customer.created", entity: "customers", entityId: customer.id, newData: { name: customer.name } });
    return ok({ customer }, 201);
  } catch (e) {
    console.error("[customers.POST]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
