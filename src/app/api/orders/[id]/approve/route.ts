import { ok, fail, withAuth, GENERIC_ERROR } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import { approveOrder, OrderError } from "@/lib/services/orders";
import { bookOrderWithFlaship, FlashipError, BookingResult } from "@/lib/flaship/service";
import type { Order } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Approve a worker-submitted order, then trigger the existing Flaship booking
 * flow. Security properties:
 *  - admin/super_admin only (workers get 403 from withAuth)
 *  - approval is persisted BEFORE any Flaship call; the booking service
 *    independently refuses orders whose approval_status is not APPROVED
 *  - if Flaship fails the order REMAINS APPROVED; the error is returned so the
 *    admin can retry safely (duplicate bookings are blocked by the service)
 *  - re-approving an already approved+booked order is a no-op (idempotent)
 */
export const POST = withAuth(["super_admin", "admin"], async (session, _req, ctx) => {
  const { id } = await (ctx as unknown as Ctx).params;
  try {
    const order: Order = await approveOrder(session, id);

    // Already booked? Never book again — return the existing booking (idempotency).
    if (order.tracking_number || order.flaship_booking_id) {
      return ok({
        order,
        booking: {
          bookingId: order.flaship_booking_id ?? "",
          trackingNumber: order.tracking_number ?? "",
          courierName: order.flaship_courier_name ?? "Flaship",
        } satisfies BookingResult,
        alreadyBooked: true,
        bookingAttempted: false,
      });
    }

    // Approved → trigger the existing booking flow (guards inside the service).
    try {
      const booking = await bookOrderWithFlaship(session, id);
      // re-read so the response reflects post-booking state (BOOKED + CN)
      const booked = await store.get<Order>("orders", id);
      return ok({ order: booked ?? order, booking, alreadyBooked: false, bookingAttempted: true });
    } catch (be) {
      // Booking failure does NOT undo the approval. Keep APPROVED and report.
      const message = be instanceof Error ? be.message : "Flaship booking failed.";
      const fresh = await store.get<Order>("orders", id);
      return ok({
        order: fresh ?? order,
        booking: null,
        bookingAttempted: true,
        bookingError: message,
      });
    }
  } catch (e) {
    if (e instanceof OrderError) return fail(e.message, 422);
    if (e instanceof FlashipError) return fail(e.message, 422);
    console.error("[orders.approve]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
