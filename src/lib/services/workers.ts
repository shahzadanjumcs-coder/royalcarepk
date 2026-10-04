import { store, IS_DEMO_MODE } from "@/lib/store";
import type { Profile } from "@/lib/types";
import { workerEarnings } from "./commission";
import { sanitizeProfile } from "@/lib/api/helpers";
import { logAudit, type Actor } from "./audit";
import { notifyAdmins } from "./notifications";
import { rejectOrder } from "./orders";

export class WorkerDeleteError extends Error {}

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

// ============================================================
// Safe worker account deletion
// ============================================================
//
// Deleting a worker removes the login account (and profile) but NEVER the
// business history. Safety net provided by migration 0003:
//   * orders.worker_id / created_by            → ON DELETE SET NULL (+ snapshots)
//   * commission_transactions.worker_id        → ON DELETE SET NULL (+ snapshot)
//   * worker_payments.worker_id                → ON DELETE SET NULL (+ snapshot)
//   * commission_rules.worker_id               → ON DELETE SET NULL
//   * audit_logs.user_id                       → ON DELETE SET NULL (user_name kept)
// Orders still pending approval are auto-rejected so no stock reservation or
// approval request is left dangling.

export interface DeleteWorkerResult {
  id: string;
  email: string;
  name: string;
  worker_code: string | null;
  auth_user_deleted: boolean;
  orders_auto_rejected: number;
}

export async function deleteWorkerAccount(session: Actor, workerId: string): Promise<DeleteWorkerResult> {
  const profile = await store.get<{
    id: string; email: string; name: string; role: string; worker_code: string | null; status: string;
  }>("profiles", workerId);
  if (!profile) throw new WorkerDeleteError("Worker not found.");
  if (profile.role !== "worker") {
    throw new WorkerDeleteError("Only worker accounts can be deleted here. Admin accounts are managed separately.");
  }
  // Guard: never allow deleting the currently signed-in account
  if (session.userId && session.userId === workerId) {
    throw new WorkerDeleteError("You cannot delete the account you are signed in with.");
  }
  // NOTE: the "last Super Admin/Admin" guard is inherently satisfied — this
  // function refuses any non-worker role above, so admin accounts can never be
  // deleted through this path at all.

  // 1. Auto-reject this worker's orders that are still waiting for approval
  //    (releases stock reservations and notifies admins; the audit trail keeps
  //    the reason). Done BEFORE the account disappears so notifications still
  //    resolve names cleanly.
  const { rows: pendingOrders } = await store.list<{ id: string }>("orders", {
    filters: { worker_id: workerId, approval_status: "PENDING" },
  });
  let autoRejected = 0;
  for (const o of pendingOrders) {
    try {
      await rejectOrder(
        { userId: session.userId, name: session.name ?? "system", role: session.role },
        o.id,
        "Worker account was deleted — order automatically rejected."
      );
      autoRejected += 1;
    } catch (e) {
      console.error("[worker.delete] auto-reject failed for order", o.id, e);
    }
  }

  // 2. Delete the auth account (live mode). profiles.id references auth.users
  //    ON DELETE CASCADE, so the profile row goes with it. Historical rows
  //    keep their snapshots thanks to the SET NULL foreign keys.
  let authDeleted = false;
  if (!IS_DEMO_MODE) {
    const { getServiceRoleClient } = await import("@/lib/supabase/server");
    const admin = getServiceRoleClient();
    if (admin) {
      const { error } = await admin.auth.admin.deleteUser(workerId);
      if (!error) {
        authDeleted = true;
      } else {
        // Orphaned profile (auth user already gone) is still deletable below.
        console.error("[worker.delete] auth delete failed, falling back to profile row:", error.message);
      }
    }
  }

  // 3. Ensure the profile row is gone (demo mode, or orphaned profile row)
  await store.delete("profiles", workerId);

  // 4. Audit + admin notification. user_id is preserved on audit_logs (SET NULL)
  //    and the deleted worker's identity is recorded explicitly.
  await logAudit({
    session,
    action: "worker.deleted",
    entity: "profiles",
    entityId: workerId,
    oldData: { email: profile.email, name: profile.name, worker_code: profile.worker_code, role: profile.role },
    newData: {
      deleted_worker_email: profile.email,
      deleted_worker_name: profile.name,
      deleted_worker_code: profile.worker_code,
      auth_user_deleted: authDeleted,
      orders_auto_rejected: autoRejected,
      history_preserved: true,
    },
  });
  await notifyAdmins({
    title: "Worker account deleted",
    message: `${profile.name} (${profile.email}) was deleted by ${session.name ?? "an admin"}. Historical orders, commissions and payments were preserved.${autoRejected ? ` ${autoRejected} pending order(s) were auto-rejected.` : ""}`,
    type: "warning",
    link: "/admin/workers",
  });

  return {
    id: workerId,
    email: profile.email,
    name: profile.name,
    worker_code: profile.worker_code,
    auth_user_deleted: authDeleted,
    orders_auto_rejected: autoRejected,
  };
}
