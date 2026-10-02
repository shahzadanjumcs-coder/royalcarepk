import { ok, fail, withAuth, GENERIC_ERROR } from "@/lib/api/helpers";
import { addManualAdjustment, CommissionError } from "@/lib/services/commission";
import { logAudit } from "@/lib/services/audit";
import { z } from "zod";

export const POST = withAuth(["super_admin", "admin"], async (session, req) => {
  try {
    const schema = z.object({
      worker_id: z.string().min(1, "Select a worker."),
      order_id: z.string().optional().nullable(),
      amount: z.number().refine((n) => n !== 0, "Amount cannot be zero."),
      description: z.string().min(3, "A description is required."),
    });
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid data.", 422);
    await addManualAdjustment({
      workerId: parsed.data.worker_id,
      orderId: parsed.data.order_id || null,
      amount: parsed.data.amount,
      description: parsed.data.description,
    });
    await logAudit({
      session, action: "commission.manual_adjustment", entity: "commission_transactions",
      newData: parsed.data as unknown as Record<string, unknown>,
    });
    return ok({ success: true }, 201);
  } catch (e) {
    if (e instanceof CommissionError) return fail(e.message, 422);
    console.error("[commission.adjustments]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
