import { ok, withAuth, parseListParams } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import type { CommissionTransaction } from "@/lib/types";

/** Commission transaction ledger (read). Workers are scoped to their own rows. */
export const GET = withAuth("any", async (session, req) => {
  const url = new URL(req.url);
  const opts = parseListParams(url, "created_at", ["description"]);
  if (url.searchParams.get("worker_id")) opts.filters!.worker_id = url.searchParams.get("worker_id");
  if (url.searchParams.get("type")) opts.filters!.type = url.searchParams.get("type");
  if (session.role === "worker") opts.filters!.worker_id = session.userId;

  const { rows, total } = await store.list<CommissionTransaction>("commission_transactions", opts);
  const { rows: profiles } = await store.list<{ id: string; name: string }>("profiles");
  const { rows: orders } = await store.list<{ id: string; order_number: string; cod_amount: number }>("orders");
  const pMap = new Map(profiles.map((p) => [p.id, p.name]));
  const oMap = new Map(orders.map((o) => [o.id, o]));
  const enriched = rows.map((t) => ({
    ...t,
    // prefer the live name, fall back to the deletion-proof snapshot
    worker_name: pMap.get(t.worker_id ?? "") ?? t.worker_name_snapshot ?? "Deleted worker",
    order_number: t.order_id ? (oMap.get(t.order_id)?.order_number ?? "—") : null,
    cod_amount: t.order_id ? (oMap.get(t.order_id)?.cod_amount ?? null) : null,
  }));
  return ok({ rows: enriched, total, page: opts.page, perPage: opts.perPage });
});
