import { ok, withAuth, fail, GENERIC_ERROR } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import { z } from "zod";
import { logAudit } from "@/lib/services/audit";
import { workerEarnings } from "@/lib/services/commission";
import type { WorkerPayment } from "@/lib/types";

export const GET = withAuth("any", async (session, req) => {
  const url = new URL(req.url);
  const view = url.searchParams.get("view") || "list"; // list | earnings
  const workerIdParam = url.searchParams.get("worker_id");

  if (view === "earnings") {
    // Per-worker net/paid/remaining summary (ledger-derived; balances never stored)
    const { rows: workers } = await store.list<{ id: string; name: string; worker_code: string | null; status: string; team_id: string | null }>(
      "profiles",
      { filters: { role: "worker" } }
    );
    const { rows: teams } = await store.list<{ id: string; name: string }>("teams");
    const tMap = new Map(teams.map((t) => [t.id, t.name]));
    const rows = await Promise.all(
      workers.map(async (w) => {
        const e = await workerEarnings(w.id);
        return { ...w, team_name: w.team_id ? (tMap.get(w.team_id) ?? null) : null, ...e };
      })
    );
    const filtered = session.role === "worker" ? rows.filter((r) => r.id === session.userId) : rows;
    return ok({ rows: filtered, total: filtered.length });
  }

  const opts = {
    filters: {} as Record<string, unknown>,
    orderBy: { field: "payment_date", dir: "desc" as const },
  };
  if (workerIdParam) opts.filters.worker_id = workerIdParam;
  if (session.role === "worker") opts.filters.worker_id = session.userId;
  const { rows, total } = await store.list<WorkerPayment>("worker_payments", opts);
  const { rows: workers } = await store.list<{ id: string; name: string }>("profiles");
  const wMap = new Map(workers.map((w) => [w.id, w.name]));
  const enriched = rows.map((p) => ({ ...p, worker_name: wMap.get(p.worker_id) ?? "—" }));
  return ok({ rows: enriched, total });
});

export const POST = withAuth(["super_admin", "admin"], async (session, req) => {
  try {
    const schema = z.object({
      worker_id: z.string().min(1, "Select a worker."),
      amount: z.number().positive("Payment amount must be greater than zero."),
      method: z.enum(["CASH", "BANK_TRANSFER", "OTHER"]),
      payment_date: z.string().min(8),
      reference: z.string().optional().nullable(),
      note: z.string().optional().nullable(),
    });
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid data.", 422);

    const worker = await store.get("profiles", parsed.data.worker_id);
    if (!worker || (worker as unknown as { role: string }).role !== "worker") {
      return fail("Selected user is not a worker.", 422);
    }

    // prevent paying more than the remaining ledger balance
    const earnings = await workerEarnings(parsed.data.worker_id);
    if (earnings.remaining_amount >= 0 && parsed.data.amount > earnings.remaining_amount) {
      return fail(
        `Payment of Rs ${parsed.data.amount.toLocaleString()} exceeds the remaining balance of Rs ${earnings.remaining_amount.toLocaleString()}. Reduce the amount or add a manual commission adjustment first.`,
        422
      );
    }

    const payment = await store.insert("worker_payments", {
      worker_id: parsed.data.worker_id,
      amount: parsed.data.amount,
      method: parsed.data.method,
      payment_date: parsed.data.payment_date,
      reference: parsed.data.reference || null,
      note: parsed.data.note || null,
      created_by: session.userId,
    });
    await logAudit({ session, action: "payment.created", entity: "worker_payments", entityId: payment.id, newData: parsed.data as unknown as Record<string, unknown> });
    return ok({ payment }, 201);
  } catch (e) {
    console.error("[payments.POST]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
