import { store } from "@/lib/store";
import type { ReportTable, ReportType } from "@/lib/types";
import { formatCurrency } from "@/lib/utils";

interface ReportContext {
  from: string;
  to: string;
}

const c = formatCurrency;

export async function runReport(type: ReportType, ctx: ReportContext): Promise<ReportTable> {
  const { from, to } = ctx;
  const ordersRange = await store.list<{
    id: string;
    order_number: string;
    customer_id: string;
    worker_id: string | null;
    status: string;
    subtotal: number;
    discount: number;
    total: number;
    cod_amount: number;
    city: string;
    created_at: string;
  }>("orders", { dateRange: { field: "created_at", from, to }, orderBy: { field: "created_at", dir: "desc" } });
  const { rows: customers } = await store.list<{ id: string; name: string; phone: string; city: string }>("customers");
  const { rows: workers } = await store.list<{ id: string; name: string; commission_rate: number; worker_code: string }>("profiles", {
    filters: { role: "worker" },
  });
  const customerMap = new Map(customers.map((x) => [x.id, x]));
  const workerMap = new Map(workers.map((x) => [x.id, x]));

  switch (type) {
    case "sales": {
      const delivered = ordersRange.rows.filter((o) => o.status === "DELIVERED");
      const rows = delivered.map((o) => ({
        order_number: o.order_number,
        date: o.created_at.slice(0, 10),
        customer: customerMap.get(o.customer_id)?.name ?? "—",
        city: o.city,
        cod: o.cod_amount,
        status: o.status,
      }));
      return {
        columns: [
          { key: "order_number", label: "Order #" },
          { key: "date", label: "Date", type: "date" },
          { key: "customer", label: "Customer" },
          { key: "city", label: "City" },
          { key: "cod", label: "COD Amount", type: "currency" },
        ],
        rows,
        totals: { cod: rows.reduce((s, r) => s + Number(r.cod), 0) },
      };
    }
    case "orders": {
      const rows = ordersRange.rows.map((o) => ({
        order_number: o.order_number,
        date: o.created_at.slice(0, 10),
        customer: customerMap.get(o.customer_id)?.name ?? "—",
        worker: o.worker_id ? (workerMap.get(o.worker_id)?.name ?? "—") : "Unassigned",
        total: o.total,
        status: o.status,
      }));
      return {
        columns: [
          { key: "order_number", label: "Order #" },
          { key: "date", label: "Date", type: "date" },
          { key: "customer", label: "Customer" },
          { key: "worker", label: "Worker" },
          { key: "total", label: "Total", type: "currency" },
          { key: "status", label: "Status" },
        ],
        rows,
        totals: { total: rows.reduce((s, r) => s + Number(r.total), 0) },
      };
    }
    case "delivered": {
      const rows = ordersRange.rows.filter((o) => o.status === "DELIVERED").map((o) => ({
        order_number: o.order_number,
        date: o.created_at.slice(0, 10),
        customer: customerMap.get(o.customer_id)?.name ?? "—",
        worker: o.worker_id ? (workerMap.get(o.worker_id)?.name ?? "—") : "—",
        cod: o.cod_amount,
      }));
      return {
        columns: [
          { key: "order_number", label: "Order #" },
          { key: "date", label: "Date", type: "date" },
          { key: "customer", label: "Customer" },
          { key: "worker", label: "Worker" },
          { key: "cod", label: "COD", type: "currency" },
        ],
        rows,
        totals: { cod: rows.reduce((s, r) => s + Number(r.cod), 0) },
      };
    }
    case "returned": {
      const rows = ordersRange.rows.filter((o) => o.status === "RETURNED").map((o) => ({
        order_number: o.order_number,
        date: o.created_at.slice(0, 10),
        customer: customerMap.get(o.customer_id)?.name ?? "—",
        worker: o.worker_id ? (workerMap.get(o.worker_id)?.name ?? "—") : "—",
        value: o.total,
      }));
      return {
        columns: [
          { key: "order_number", label: "Order #" },
          { key: "date", label: "Date", type: "date" },
          { key: "customer", label: "Customer" },
          { key: "worker", label: "Worker" },
          { key: "value", label: "Order Value", type: "currency" },
        ],
        rows,
        totals: { value: rows.reduce((s, r) => s + Number(r.value), 0) },
      };
    }
    case "worker-performance": {
      const rows = workers.map((w) => {
        const own = ordersRange.rows.filter((o) => o.worker_id === w.id);
        const delivered = own.filter((o) => o.status === "DELIVERED");
        const returned = own.filter((o) => o.status === "RETURNED").length;
        const total = own.length;
        return {
          worker: w.name,
          code: w.worker_code,
          total,
          delivered: delivered.length,
          returned,
          success_rate: total ? `${Math.round((delivered.length / total) * 100)}%` : "0%",
          delivered_value: delivered.reduce((s, o) => s + o.cod_amount, 0),
        };
      }).sort((a, b) => b.delivered - a.delivered);
      return {
        columns: [
          { key: "worker", label: "Worker" },
          { key: "code", label: "Worker ID" },
          { key: "total", label: "Assigned", type: "number" },
          { key: "delivered", label: "Delivered", type: "number" },
          { key: "returned", label: "Returned", type: "number" },
          { key: "success_rate", label: "Success Rate" },
          { key: "delivered_value", label: "Delivered Value", type: "currency" },
        ],
        rows,
        totals: { delivered: rows.reduce((s, r) => s + Number(r.delivered), 0) },
      };
    }
    case "worker-commission": {
      const { rows: txns } = await store.list<{
        worker_id: string;
        order_id: string | null;
        type: string;
        amount: number;
        rate: number | null;
        description: string | null;
        created_at: string;
      }>("commission_transactions", { dateRange: { field: "created_at", from, to }, orderBy: { field: "created_at", dir: "desc" } });
      const { rows: ordersAll } = await store.list<{ id: string; order_number: string }>("orders");
      const orderMap = new Map(ordersAll.map((o) => [o.id, o.order_number]));
      const rows = txns.map((t) => ({
        date: t.created_at.slice(0, 10),
        worker: workerMap.get(t.worker_id)?.name ?? "—",
        order: t.order_id ? (orderMap.get(t.order_id) ?? "—") : "—",
        type: t.type.replace(/_/g, " "),
        rate: t.rate ? `${t.rate}%` : "—",
        amount: t.amount,
      }));
      return {
        columns: [
          { key: "date", label: "Date", type: "date" },
          { key: "worker", label: "Worker" },
          { key: "order", label: "Order #" },
          { key: "type", label: "Type" },
          { key: "rate", label: "Rate" },
          { key: "amount", label: "Amount", type: "currency" },
        ],
        rows,
        totals: { amount: rows.reduce((s, r) => s + Number(r.amount), 0) },
      };
    }
    case "worker-payments": {
      const { rows: pays } = await store.list<{
        worker_id: string;
        amount: number;
        method: string;
        payment_date: string;
        reference: string | null;
      }>("worker_payments", { dateRange: { field: "payment_date", from, to }, orderBy: { field: "payment_date", dir: "desc" } });
      const rows = pays.map((p) => ({
        date: p.payment_date,
        worker: workerMap.get(p.worker_id)?.name ?? "—",
        amount: p.amount,
        method: p.method.replace(/_/g, " "),
        reference: p.reference ?? "—",
      }));
      return {
        columns: [
          { key: "date", label: "Date", type: "date" },
          { key: "worker", label: "Worker" },
          { key: "amount", label: "Amount", type: "currency" },
          { key: "method", label: "Method" },
          { key: "reference", label: "Reference" },
        ],
        rows,
        totals: { amount: rows.reduce((s, r) => s + Number(r.amount), 0) },
      };
    }
    case "pending-payments": {
      const { rows: allTxns } = await store.list<{ worker_id: string; amount: number }>("commission_transactions");
      const { rows: allPays } = await store.list<{ worker_id: string; amount: number }>("worker_payments");
      const rows = workers.map((w) => {
        const net = allTxns.filter((t) => t.worker_id === w.id).reduce((s, t) => s + t.amount, 0);
        const paid = allPays.filter((p) => p.worker_id === w.id).reduce((s, p) => s + p.amount, 0);
        return { worker: w.name, code: w.worker_code, net, paid, remaining: net - paid };
      }).filter((r) => r.remaining > 0);
      return {
        columns: [
          { key: "worker", label: "Worker" },
          { key: "code", label: "Worker ID" },
          { key: "net", label: "Net Commission", type: "currency" },
          { key: "paid", label: "Paid", type: "currency" },
          { key: "remaining", label: "Remaining", type: "currency" },
        ],
        rows,
        totals: { remaining: rows.reduce((s, r) => s + Number(r.remaining), 0) },
      };
    }
    case "inventory": {
      const { rows: products } = await store.list<{
        name: string;
        sku: string;
        current_stock: number;
        reserved_stock: number;
        min_stock: number;
        purchase_price: number;
        selling_price: number;
      }>("products", { orderBy: { field: "name", dir: "asc" } });
      const rows = products.map((p) => ({
        product: p.name,
        sku: p.sku,
        current: p.current_stock,
        reserved: p.reserved_stock,
        available: p.current_stock - p.reserved_stock,
        min_stock: p.min_stock,
        stock_value: p.current_stock * p.purchase_price,
        retail_value: p.current_stock * p.selling_price,
        low: p.current_stock - p.reserved_stock <= p.min_stock ? "LOW" : "OK",
      }));
      return {
        columns: [
          { key: "product", label: "Product" },
          { key: "sku", label: "SKU" },
          { key: "current", label: "Current", type: "number" },
          { key: "reserved", label: "Reserved", type: "number" },
          { key: "available", label: "Available", type: "number" },
          { key: "stock_value", label: "Stock Value", type: "currency" },
          { key: "low", label: "Status" },
        ],
        rows,
        totals: { stock_value: rows.reduce((s, r) => s + Number(r.stock_value), 0) },
      };
    }
    case "stock-movement": {
      const { rows: movements } = await store.list<{
        product_id: string;
        type: string;
        quantity: number;
        reserved_change: number;
        note: string | null;
        created_at: string;
      }>("inventory_movements", { dateRange: { field: "created_at", from, to }, orderBy: { field: "created_at", dir: "desc" } });
      const { rows: products } = await store.list<{ id: string; name: string; sku: string }>("products");
      const productMap = new Map(products.map((p) => [p.id, p]));
      const rows = movements.map((m) => ({
        date: m.created_at.slice(0, 10),
        product: productMap.get(m.product_id)?.name ?? "—",
        sku: productMap.get(m.product_id)?.sku ?? "—",
        type: m.type.replace(/_/g, " "),
        qty: m.quantity,
        reserved: m.reserved_change,
        note: m.note ?? "—",
      }));
      return {
        columns: [
          { key: "date", label: "Date", type: "date" },
          { key: "product", label: "Product" },
          { key: "sku", label: "SKU" },
          { key: "type", label: "Type" },
          { key: "qty", label: "Stock Δ", type: "number" },
          { key: "reserved", label: "Reserved Δ", type: "number" },
          { key: "note", label: "Note" },
        ],
        rows,
      };
    }
    case "product-sales": {
      const { rows: items } = await store.list<{
        order_id: string;
        product_name: string;
        sku: string;
        quantity: number;
        line_total: number;
      }>("order_items");
      const orderStatus = new Map(ordersRange.rows.map((o) => [o.id, o.status]));
      const agg = new Map<string, { name: string; sku: string; qty: number; revenue: number; deliveredQty: number }>();
      for (const it of items) {
        const st = orderStatus.get(it.order_id);
        if (!st) continue;
        const key = it.sku;
        const slot = agg.get(key) ?? { name: it.product_name, sku: it.sku, qty: 0, revenue: 0, deliveredQty: 0 };
        slot.qty += it.quantity;
        slot.revenue += it.line_total;
        if (st === "DELIVERED") slot.deliveredQty += it.quantity;
        agg.set(key, slot);
      }
      const rows = Array.from(agg.values()).sort((a, b) => b.revenue - a.revenue);
      return {
        columns: [
          { key: "product", label: "Product" },
          { key: "sku", label: "SKU" },
          { key: "qty", label: "Units Ordered", type: "number" },
          { key: "deliveredQty", label: "Units Delivered", type: "number" },
          { key: "revenue", label: "Revenue", type: "currency" },
        ],
        rows,
        totals: { revenue: rows.reduce((s, r) => s + Number(r.revenue), 0) },
      };
    }
    case "customer": {
      const rows = customers.map((cu) => {
        const own = ordersRange.rows.filter((o) => o.customer_id === cu.id);
        const delivered = own.filter((o) => o.status === "DELIVERED");
        return {
          customer: cu.name,
          phone: cu.phone,
          city: cu.city,
          orders: own.length,
          delivered: delivered.length,
          returned: own.filter((o) => o.status === "RETURNED").length,
          spending: delivered.reduce((s, o) => s + o.cod_amount, 0),
        };
      }).filter((r) => r.orders > 0).sort((a, b) => b.spending - a.spending);
      return {
        columns: [
          { key: "customer", label: "Customer" },
          { key: "phone", label: "Phone" },
          { key: "city", label: "City" },
          { key: "orders", label: "Orders", type: "number" },
          { key: "delivered", label: "Delivered", type: "number" },
          { key: "returned", label: "Returned", type: "number" },
          { key: "spending", label: "Total Spending", type: "currency" },
        ],
        rows,
        totals: { spending: rows.reduce((s, r) => s + Number(r.spending), 0) },
      };
    }
  }
}

export function reportTitle(type: ReportType): string {
  const map: Record<ReportType, string> = {
    sales: "Sales Report",
    orders: "Orders Report",
    delivered: "Delivered Report",
    returned: "Returned Report",
    "worker-performance": "Worker Performance",
    "worker-commission": "Worker Commission",
    "worker-payments": "Worker Payments",
    "pending-payments": "Pending Worker Payments",
    inventory: "Inventory Report",
    "stock-movement": "Stock Movement Report",
    "product-sales": "Product Sales",
    customer: "Customer Report",
  };
  return map[type];
}

export { c as currencyFmt };
