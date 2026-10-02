import { ok, fail, withAuth, GENERIC_ERROR } from "@/lib/api/helpers";
import { syncCatalog, listCouriers, listCities, listPickups, getFlashipConfig } from "@/lib/flaship/service";
import { logAudit } from "@/lib/services/audit";

export const GET = withAuth("any", async (_session, req) => {
  const url = new URL(req.url);
  const type = url.searchParams.get("type");
  if (!type) {
    const [couriers, cities, pickups] = await Promise.all([listCouriers(), listCities(), listPickups()]);
    const cfg = await getFlashipConfig();
    return ok({ couriers, cities, pickups, mode: cfg.mode, api_key_set: cfg.api_key_set });
  }
  if (type === "couriers") return ok({ rows: await listCouriers() });
  if (type === "cities") return ok({ rows: await listCities() });
  if (type === "pickups") return ok({ rows: await listPickups() });
  return fail("Unknown catalog type.", 422);
});

export const POST = withAuth(["super_admin", "admin"], async (session, req) => {
  try {
    const { type } = (await req.json()) as { type?: "couriers" | "cities" | "pickups" | "all" };
    if (!type || !["couriers", "cities", "pickups", "all"].includes(type)) {
      return fail("Specify a catalog type: couriers, cities, pickups or all.", 422);
    }
    const counts = await syncCatalog(type);
    const count = counts.couriers + counts.cities + counts.pickups;
    await logAudit({ session, action: "flaship.catalog_synced", entity: "flaship", newData: { type, counts } });
    return ok({ success: true, counts, count, type });
  } catch (e) {
    if (e instanceof Error && /flaship/i.test(e.message)) return fail(e.message, 502);
    console.error("[flaship.catalog]", e);
    return fail("Could not sync the Flaship catalog. Check the API configuration and retry.", 500);
  }
});
