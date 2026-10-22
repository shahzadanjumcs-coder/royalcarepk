import type { OrderStatus } from "@/lib/types";

/**
 * Allowed order status transitions (pragmatic courier workflow).
 *
 * Single source of truth, shared by:
 *   - services/orders.ts  → changeOrderStatus() enforcement for manual changes
 *   - flaship/service.ts  → tracking sync's out-of-order guard (a stale or
 *     out-of-order tracking response must never auto-apply a backward
 *     transition and regress a newer valid order status)
 *
 * Lives in its own dependency-free module so the tracking sync can consult the
 * REAL map even in test suites that mock the orders service with partial fakes.
 */
export const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  // CREATED orders are admin-created (approval_status APPROVED) and can be
  // booked directly — bookOrderWithFlaship books on Flaship FIRST and then
  // moves the order to BOOKED; rejecting CREATED→BOOKED left booked orders
  // stuck as CREATED with booking_status "failed" and fired no WhatsApp event.
  CREATED: ["PENDING", "ASSIGNED", "BOOKED", "CANCELLED"],
  PENDING: ["ASSIGNED", "BOOKED", "CANCELLED"],
  ASSIGNED: ["PENDING", "BOOKED", "CANCELLED"],
  BOOKED: ["IN_TRANSIT", "RETURNED", "CANCELLED"],
  IN_TRANSIT: ["DELIVERED", "RETURNED"],
  DELIVERED: ["RETURNED"],
  RETURNED: [],
  CANCELLED: [],
};

/** True when the order-status transition from → to is allowed. */
export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}
