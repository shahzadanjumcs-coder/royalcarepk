import { ok, withAuth, parseListParams } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import type { AuditLog } from "@/lib/types";

export const GET = withAuth(["super_admin", "admin"], async (_session, req) => {
  const url = new URL(req.url);
  const opts = parseListParams(url, "created_at", ["action", "entity", "user_name"]);
  if (url.searchParams.get("entity")) opts.filters!.entity = url.searchParams.get("entity");
  if (url.searchParams.get("action")) opts.filters!.action = url.searchParams.get("action");
  const { rows, total } = await store.list<AuditLog>("audit_logs", opts);
  return ok({ rows, total, page: opts.page, perPage: opts.perPage });
});
