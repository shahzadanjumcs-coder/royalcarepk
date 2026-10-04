import { ok, fail, withAuth, parseListParams, GENERIC_ERROR } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import { createOrder, CreateOrderInput, OrderError } from "@/lib/services/orders";
import type { Order, Session } from "@/lib/types";
import { z } from "zod";

export const GET = withAuth("any", async (session, req) => {
  const url = new URL(req.url);
  const opts = parseListParams(url, "created_at", ["order_number", "city", "tracking_number"]);
  opts.filters = { ...(opts.filters ?? {}) };
  if (session.role === "worker") {
    opts.filters.worker_id = session.userId;
  }
  // approval workflow filter (PENDING / APPROVED / REJECTED / ALL)
  const approvalParam = url.searchParams.get("approval");
  if (approvalParam && approvalParam !== "ALL") {
    opts.filters.approval_status = approvalParam;
  }
  const includeItems = url.searchParams.get("include_items") === "1" && (opts.perPage ?? 0) <= 100;
  // status arrives via parseListParams as an equality filter — replace it with the
  // group-aware IN filter below (ALL / PENDING / UNBOOKED groups or a single status).
  // NEVER keep the raw equality value: a literal "UNBOOKED" status matches no row and
  // intersected with the IN filter it would empty the Flaship Booking Console list.
  const statusParam = url.searchParams.get("status");
  delete opts.filters.status;
  let statuses: string[] | null = null;
  let nullFilters: string[] | undefined;
  if (statusParam === "PENDING") statuses = ["CREATED", "PENDING"];
  else if (statusParam === "UNBOOKED") {
    // eligible = not yet booked: still open AND no tracking number / in-flight booking
    statuses = ["CREATED", "PENDING", "ASSIGNED"];
    nullFilters = ["tracking_number"];
    opts.filters.booking_status = "not_booked";
  } else if (statusParam && statusParam !== "ALL") statuses = [statusParam];

  const { rows, total } = await store.list<Order>("orders", {
    ...opts,
    filters: opts.filters as Record<string, unknown>,
    inFilters: statuses ? { status: statuses } : undefined,
    nullFilters,
  });

  const customerIds = [...new Set(rows.map((r) => r.customer_id))];
  const workerIds = [...new Set(rows.map((r) => r.worker_id).filter(Boolean))] as string[];
  const [customers, workers] = await Promise.all([
    store.list<{ id: string; name: string; phone: string }>("customers"),
    workerIds.length ? store.list<{ id: string; name: string }>("profiles", { inFilters: { id: workerIds } }) : Promise.resolve({ rows: [], total: 0 }),
  ]);
  const cMap = new Map(customers.rows.map((c) => [c.id, c]));
  const wMap = new Map(workers.rows.map((w) => [w.id, w]));

  const enriched = rows.map((o) => ({
    ...o,
    customer_name: cMap.get(o.customer_id)?.name ?? "—",
    customer_phone: cMap.get(o.customer_id)?.phone ?? "—",
    worker_name: o.worker_id ? (wMap.get(o.worker_id)?.name ?? null) : (o.worker_name_snapshot ?? null),
  }));

  // optional per-order items (used by the admin Pending Approvals card)
  if (includeItems && rows.length) {
    const orderIds = rows.map((r) => r.id);
    const { rows: itemRows } = await store.list<{ id: string; order_id: string; product_name: string; quantity: number; line_total: number }>(
      "order_items",
      { filters: {}, inFilters: { order_id: orderIds }, perPage: 100 }
    );
    const byOrder = new Map<string, { product_name: string; quantity: number; line_total: number }[]>();
    for (const it of itemRows) {
      const list = byOrder.get(it.order_id) ?? [];
      list.push({ product_name: it.product_name, quantity: it.quantity, line_total: it.line_total });
      byOrder.set(it.order_id, list);
    }
    for (const o of enriched) {
      (o as Record<string, unknown>).items = byOrder.get(o.id) ?? [];
    }
  }

  return ok({ rows: enriched, total, page: opts.page, perPage: opts.perPage });
});

const orderSchema = z.object({
  customer: z.object({
    id: z.string().min(1).optional(),
    name: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().optional(),
    address: z.string().optional(),
    city: z.string().optional(),
  }),
  items: z.array(z.object({
    product_id: z.string().min(1),
    quantity: z.number().positive(),
    unit_price: z.number().nonnegative(),
  })).min(1),
  discount: z.number().nonnegative().default(0),
  cod_amount: z.number().nonnegative().optional(),
  delivery_address: z.string().min(1),
  city: z.string().min(1),
  notes: z.string().optional().nullable(),
  worker_id: z.string().min(1).optional().nullable(),
});

/**
 * Create an order.
 * - Admins/super admins: full existing behaviour (assign to any worker, auto-approved).
 * - Workers: submit their own order for admin approval — approval_status starts
 *   PENDING and Flaship booking is NOT attempted until an admin approves it.
 *   worker_id is forced from the session, never trusted from the client.
 */
export const POST = withAuth(["super_admin", "admin", "worker"], async (session: Session, req) => {
  try {
    const body = await req.json();
    const parsed = orderSchema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return fail(first?.message ?? "Invalid order data.", 422);
    }
    if (session.role === "worker") {
      // security: a worker can only submit orders for themselves
      parsed.data.worker_id = session.userId;
    }
    const order = await createOrder(session, parsed.data as CreateOrderInput);
    return ok({ order }, 201);
  } catch (e) {
    if (e instanceof OrderError) return fail(e.message, 422);
    console.error("[orders.POST]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
