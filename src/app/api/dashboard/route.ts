import { ok, withAuth } from "@/lib/api/helpers";
import { getDashboard } from "@/lib/services/dashboard";
import { resolveRange, RangePreset } from "@/lib/utils";

export const GET = withAuth(["super_admin", "admin", "inventory_manager"], async (_session, req) => {
  const url = new URL(req.url);
  const preset = (url.searchParams.get("preset") || "30d") as RangePreset;
  const range = resolveRange(preset, url.searchParams.get("from") ?? undefined, url.searchParams.get("to") ?? undefined);
  const data = await getDashboard(range.from, range.to);
  return ok({ ...data, range });
});
