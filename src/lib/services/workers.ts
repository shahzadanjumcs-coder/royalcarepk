import { store } from "@/lib/store";
import type { Profile } from "@/lib/types";
import { workerEarnings } from "./commission";
import { sanitizeProfile } from "@/lib/api/helpers";

export interface WorkerDetail extends Profile {
  earnings: Awaited<ReturnType<typeof workerEarnings>>;
  performance: {
    today_orders?: number;
    total_orders: number;
    delivered: number;
    returned: number;
    in_progress: number;
    success_rate: string;
    total_cod: number;
  };
  recent_orders: {
    id: string;
    order_number: string;
    customer_name: string;
    status: string;
    total: number;
    tracking_number: string | null;
    created_at: string;
  }[];
}

export async function getWorkerDetail(workerId: string): Promise<WorkerDetail | null> {
  const worker = await store.get<Profile>("profiles", workerId);
  if (!worker) return null;
  const safeWorker = sanitizeProfile(worker);

  let team_name: string | null = null;
  if (worker.team_id) {
    const team = await store.get<{ name: string }>("teams", worker.team_id);
    team_name = team?.name ?? null;
  }

  const earnings = await workerEarnings(workerId);
  const { rows: orders } = await store.list<{
    id: string;
    order_number: string;
    customer_id: string;
    status: string;
    total: number;
    tracking_number: string | null;
    created_at: string;
  }>("orders", { filters: { worker_id: workerId }, orderBy: { field: "created_at", dir: "desc" } });
  const { rows: customers } = await store.list<{ id: string; name: string }>("customers");
  const customerMap = new Map(customers.map((c) => [c.id, c.name]));

  const delivered = orders.filter((o) => o.status === "DELIVERED");
  const returned = orders.filter((o) => o.status === "RETURNED");
  const inProgress = orders.filter((o) => ["CREATED", "PENDING", "ASSIGNED", "BOOKED", "IN_TRANSIT"].includes(o.status));

  const today = new Date().toISOString().slice(0, 10);
  const { total: todayOrders } = await store.list("orders", {
    filters: { worker_id: workerId },
    dateRange: { field: "created_at", from: today, to: today },
  });

  return {
    ...safeWorker,
    team_name,
    earnings,
    performance: {
      today_orders: todayOrders,
      total_orders: orders.length,
      delivered: delivered.length,
      returned: returned.length,
      in_progress: inProgress.length,
      success_rate: orders.length ? `${Math.round((delivered.length / orders.length) * 100)}%` : "0%",
      total_cod: delivered.reduce((s, o) => s + o.total, 0),
    },
    recent_orders: orders.slice(0, 20).map((o) => ({
      id: o.id,
      order_number: o.order_number,
      customer_name: customerMap.get(o.customer_id) ?? "—",
      status: o.status,
      total: o.total,
      tracking_number: o.tracking_number,
      created_at: o.created_at,
    })),
  };
}

/** Next worker code like W-0007 */
export async function nextWorkerCode(): Promise<string> {
  const { rows } = await store.list<{ worker_code: string | null }>("profiles", { filters: { role: "worker" } });
  const max = rows.reduce((m, w) => {
    const n = parseInt((w.worker_code ?? "").replace(/\D/g, ""), 10);
    return isNaN(n) ? m : Math.max(m, n);
  }, 0);
  return `W-${String(max + 1).padStart(4, "0")}`;
}
