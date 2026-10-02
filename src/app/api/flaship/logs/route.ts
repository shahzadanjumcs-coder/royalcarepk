import { ok, withAuth, parseListParams } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import type { FlashipLog } from "@/lib/types";

/** Flaship request/response logs (secrets already redacted at write time). Admin only. */
export const GET = withAuth(["super_admin", "admin"], async (_session, req) => {
  const url = new URL(req.url);
  const opts = parseListParams(url, "created_at", ["endpoint", "error"]);
  if (url.searchParams.get("success")) opts.filters!.success = url.searchParams.get("success") === "true";
  const { rows, total } = await store.list<FlashipLog>("flaship_logs", opts);
  const { rows: orders } = await store.list<{ id: string; order_number: string }>("orders");
  const oMap = new Map(orders.map((o) => [o.id, o.order_number]));
  const enriched = rows.map((l) => ({ ...l, order_number: l.order_id ? (oMap.get(l.order_id) ?? null) : null }));
  return ok({ rows: enriched, total, page: opts.page, perPage: opts.perPage });
});
