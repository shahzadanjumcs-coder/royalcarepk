import { store } from "@/lib/store";
import type { CommissionType } from "@/lib/types";
import { notifyWorker } from "./notifications";

export class CommissionError extends Error {}

/**
 * Commission ledger engine.
 *
 * Business rules (enforced here, and mirrored by unique partial indexes in SQL):
 *  1. DELIVERED → credit DELIVERED_COMMISSION once, using the rate snapshot stored on the order.
 *  2. RETURNED  → if (and only if) a DELIVERED_COMMISSION exists for the order, deduct it once
 *                 via RETURN_ADJUSTMENT so the net effect is zero.
 *  3. CANCELLED → no commission, ever.
 *  4. Rate changes never recalculate historical transactions.
 *  5. Duplicate status events are no-ops (idempotent).
 *
 * Amounts are derived from order.cod_amount × order.commission_rate (snapshot).
 * Worker balances are ALWAYS derived from this ledger — never stored.
 */
async function hasTransaction(orderId: string, type: CommissionType): Promise<boolean> {
  const existing = await store.first("commission_transactions", { order_id: orderId, type });
  return !!existing;
}

export async function creditDeliveredCommission(orderId: string): Promise<void> {
  const order = await store.get<{ id: string; worker_id: string | null; cod_amount: number; total: number; commission_rate: number | null; order_number: string }>(
    "orders",
    orderId
  );
  if (!order) return;
  if (!order.worker_id) return;
  if (await hasTransaction(orderId, "DELIVERED_COMMISSION")) return; // idempotent

  const rate = order.commission_rate ?? 0;
  const base = order.cod_amount ?? order.total ?? 0;
  const amount = Math.round((base * rate) / 100);

  try {
    await store.insert("commission_transactions", {
      worker_id: order.worker_id,
      order_id: orderId,
      type: "DELIVERED_COMMISSION" as CommissionType,
      amount,
      rate,
      description: `${rate}% commission on delivered order ${order.order_number}`,
    });
    await notifyWorker(order.worker_id, {
      title: "Commission credited",
      message: `Rs ${amount.toLocaleString()} commission credited for order ${order.order_number}.`,
      type: "success",
      link: "/worker/earnings",
    });
  } catch (e) {
    // Unique constraint violation → concurrent duplicate; treat as already-credited.
    if (!/duplicate/i.test(String(e))) throw e;
  }
}

export async function deductReturnedCommission(orderId: string): Promise<void> {
  const order = await store.get<{ id: string; worker_id: string | null; order_number: string }>("orders", orderId);
  if (!order || !order.worker_id) return;
  if (await hasTransaction(orderId, "RETURN_ADJUSTMENT")) return; // idempotent

  const delivered = await store.first<{ amount: number; worker_id: string }>("commission_transactions", {
    order_id: orderId,
    type: "DELIVERED_COMMISSION",
  });
  // No delivered credit → nothing to deduct (net stays 0 per business rule)
  if (!delivered) return;

  try {
    await store.insert("commission_transactions", {
      worker_id: delivered.worker_id,
      order_id: orderId,
      type: "RETURN_ADJUSTMENT" as CommissionType,
      amount: -Math.abs(delivered.amount),
      rate: null,
      description: `Return adjustment for order ${order.order_number}`,
    });
    await notifyWorker(delivered.worker_id, {
      title: "Commission adjusted",
      message: `Rs ${Math.abs(delivered.amount).toLocaleString()} deducted for returned order ${order.order_number}.`,
      type: "warning",
      link: "/worker/earnings",
    });
  } catch (e) {
    if (!/duplicate/i.test(String(e))) throw e;
  }
}

/** Manual admin adjustment (positive or negative). */
export async function addManualAdjustment(params: {
  workerId: string;
  orderId?: string | null;
  amount: number;
  description: string;
}): Promise<void> {
  if (!params.amount) throw new CommissionError("Adjustment amount cannot be zero.");
  await store.insert("commission_transactions", {
    worker_id: params.workerId,
    order_id: params.orderId ?? null,
    type: "MANUAL_ADJUSTMENT" as CommissionType,
    amount: params.amount,
    rate: null,
    description: params.description,
  });
}

/** Ledger summary for one worker. */
export async function workerEarnings(workerId: string): Promise<{
  delivered_commission: number;
  return_adjustment: number;
  manual_adjustment: number;
  net_commission: number;
  paid_amount: number;
  remaining_amount: number;
}> {
  const { rows } = await store.list<{ amount: number; type: CommissionType }>("commission_transactions", {
    filters: { worker_id: workerId },
  });
  let delivered = 0;
  let returned = 0;
  let manual = 0;
  for (const t of rows) {
    if (t.type === "DELIVERED_COMMISSION") delivered += t.amount;
    else if (t.type === "RETURN_ADJUSTMENT") returned += t.amount;
    else manual += t.amount;
  }
  const paidRows = await store.list<{ amount: number }>("worker_payments", {
    filters: { worker_id: workerId },
  });
  const paid = paidRows.rows.reduce((s, p) => s + p.amount, 0);
  const net = delivered + returned + manual;
  return {
    delivered_commission: delivered,
    return_adjustment: returned,
    manual_adjustment: manual,
    net_commission: net,
    paid_amount: paid,
    remaining_amount: net - paid,
  };
}

/**
 * Entry point called by the order status engine.
 * Only DELIVERED / RETURNED touch the ledger; everything else is a no-op.
 */
export async function processCommissionForStatus(orderId: string, status: string): Promise<void> {
  if (status === "DELIVERED") return creditDeliveredCommission(orderId);
  if (status === "RETURNED") return deductReturnedCommission(orderId);
}
