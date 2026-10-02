import { store } from "@/lib/store";
import type { DashboardStats, TimeSeriesPoint } from "@/lib/types";
import { lowStockProducts } from "./inventory";

export interface DashboardData {
  stats: DashboardStats;
  series: TimeSeriesPoint[];
  statusDistribution: { status: string; count: number }[];
  workerPerformance: { name: string; delivered: number; returned: number; commission: number }[];
  inventoryMovement: { label: string; in: number; out: number }[];
  recentOrders: {
    id: string;
    order_number: string;
    customer_name: string;
    status: string;
    total: number;
    created_at: string;
  }[];
  lowStock: { id: string; name: string; sku: string; available: number; min_stock: number }[];
  failedBookings: number;
}

function dayKey(iso: string) {
  return iso.slice(0, 10);
}

export async function getDashboard(from: string, to: string): Promise<DashboardData> {
  const { rows: allOrders } = await store.list<{
    id: string;
    order_number: string;
    customer_id: string;
    worker_id: string | null;
    status: string;
    total: number;
    cod_amount: number;
    booking_status: string;
    created_at: string;
  }>("orders");
  const { rows: rangeOrders } = await store.list<{ id: string; customer_id: string; worker_id: string | null; status: string; total: number; created_at: string }>("orders", {
    dateRange: { field: "created_at", from, to },
  });

  const today = new Date().toISOString().slice(0, 10);

  // ---- stats ----
  let totalSales = 0;
  let totalCOD = 0;
  for (const o of allOrders) {
    if (o.status === "DELIVERED") {
      totalSales += o.total;
      totalCOD += o.cod_amount ?? o.total;
    }
  }
  const statusCount = (s: string) => allOrders.filter((o) => o.status === s).length;

  const { rows: commissionRows } = await store.list<{ amount: number; type: string; worker_id: string }>("commission_transactions");
  const totalCommission = commissionRows.filter((t) => t.type === "DELIVERED_COMMISSION").reduce((s, t) => s + t.amount, 0);
  const netCommission = commissionRows.reduce((s, t) => s + t.amount, 0);
  const { rows: payments } = await store.list<{ amount: number }>("worker_payments");
  const paidCommission = payments.reduce((s, p) => s + p.amount, 0);

  const { rows: products } = await store.list<{ current_stock: number; purchase_price: number; reserved_stock: number; min_stock: number }>("products");
  const stockValue = products.reduce((s, p) => s + p.current_stock * p.purchase_price, 0);
  const low = await lowStockProducts(10);

  const stats: DashboardStats = {
    totalOrders: allOrders.length,
    todayOrders: allOrders.filter((o) => dayKey(o.created_at) === today).length,
    pendingOrders: rangeOrders.filter((o) => ["CREATED", "PENDING", "ASSIGNED"].includes(o.status)).length,
    inTransit: allOrders.filter((o) => o.status === "IN_TRANSIT").length,
    delivered: allOrders.filter((o) => o.status === "DELIVERED").length,
    returned: allOrders.filter((o) => o.status === "RETURNED").length,
    cancelled: allOrders.filter((o) => o.status === "CANCELLED").length,
    booked: allOrders.filter((o) => o.status === "BOOKED").length,
    totalSales,
    totalCOD,
    stockValue,
    lowStockProducts: low.length,
    totalCommission,
    paidCommission,
    pendingPayments: netCommission - paidCommission,
    netCommission,
  };

  // ---- daily series over range ----
  const seriesMap = new Map<string, TimeSeriesPoint>();
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    seriesMap.set(key, {
      date: key,
      label: new Date(key).toLocaleDateString("en-GB", { day: "2-digit", month: "short" }),
      orders: 0,
      delivered: 0,
      returned: 0,
      sales: 0,
    });
  }
  for (const o of allOrders) {
    const key = dayKey(o.created_at);
    const point = seriesMap.get(key);
    if (!point) continue;
    point.orders++;
    if (o.status === "DELIVERED") {
      point.delivered++;
      point.sales += o.total;
    }
    if (o.status === "RETURNED") point.returned++;
  }
  const series = Array.from(seriesMap.values());

  // ---- status distribution ----
  const statuses = ["DELIVERED", "RETURNED", "IN_TRANSIT", "BOOKED", "ASSIGNED", "PENDING", "CREATED", "CANCELLED"];
  const statusDistribution = statuses.map((s) => ({ status: s, count: statusCount(s) })).filter((x) => x.count > 0);

  // ---- worker performance (in range) ----
  const { rows: workers } = await store.list<{ id: string; name: string }>("profiles", { filters: { role: "worker" } });
  const workerPerf = workers.map((w) => {
    const own = rangeOrders.filter((o) => o.worker_id === w.id);
    return {
      name: w.name,
      delivered: own.filter((o) => o.status === "DELIVERED").length,
      returned: own.filter((o) => o.status === "RETURNED").length,
      commission: commissionRows
        .filter((t) => t.worker_id === w.id && t.type === "DELIVERED_COMMISSION")
        .reduce((s, t) => s + t.amount, 0),
    };
  }).sort((a, b) => b.delivered - a.delivered);

  // ---- inventory movement (last 14 days) ----
  const { rows: movements } = await store.list<{ type: string; quantity: number; created_at: string }>("inventory_movements", {
    dateRange: { field: "created_at", from: new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) },
  });
  const invMap = new Map<string, { in: number; out: number }>();
  for (let d = 13; d >= 0; d--) {
    const key = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    invMap.set(key, { in: 0, out: 0 });
  }
  for (const m of movements) {
    const key = dayKey(m.created_at);
    const slot = invMap.get(key);
    if (!slot) continue;
    if (m.quantity > 0) slot.in += m.quantity;
    if (m.quantity < 0) slot.out += -m.quantity;
  }
  const inventoryMovement = Array.from(invMap.entries()).map(([key, v]) => ({
    label: new Date(key).toLocaleDateString("en-GB", { day: "2-digit", month: "short" }),
    ...v,
  }));

  // ---- recent orders + low stock + failed bookings ----
  const { rows: recent } = await store.list<{ id: string; order_number: string; customer_id: string; status: string; total: number; booking_status: string; created_at: string }>("orders", { orderBy: { field: "created_at", dir: "desc" }, page: 1, perPage: 6 });
  const { rows: customers } = await store.list<{ id: string; name: string }>("customers");
  const customerMap = new Map(customers.map((c) => [c.id, c.name]));
  const recentOrders = recent.map((o) => ({
    id: o.id,
    order_number: o.order_number,
    customer_name: customerMap.get(o.customer_id) ?? "—",
    status: o.status,
    total: o.total,
    created_at: o.created_at,
  }));

  const failedBookings = allOrders.filter((o) => o.booking_status === "failed").length;

  return {
    stats,
    series,
    statusDistribution,
    workerPerformance: workerPerf.slice(0, 8),
    inventoryMovement,
    recentOrders,
    lowStock: low.slice(0, 5).map((p) => ({
      id: p.id,
      name: p.name,
      sku: p.sku,
      available: p.current_stock - p.reserved_stock,
      min_stock: p.min_stock,
    })),
    failedBookings,
  };
}
