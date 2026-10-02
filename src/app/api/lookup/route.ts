import { ok, withAuth } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import { getFlashipConfig } from "@/lib/flaship/service";

/** One call to populate create-order form dropdowns. */
export const GET = withAuth(["super_admin", "admin"], async () => {
  const [customers, products, workers, couriers, cities, pickups, cfg] = await Promise.all([
    store.list<{ id: string; name: string; phone: string; city: string | null; address: string | null }>("customers", { filters: { status: "active" }, orderBy: { field: "name", dir: "asc" } }),
    store.list<{ id: string; name: string; sku: string; selling_price: number; current_stock: number; reserved_stock: number; status: string }>("products", { filters: { status: "active" }, orderBy: { field: "name", dir: "asc" } }),
    store.list<{ id: string; name: string; commission_rate: number; status: string }>("profiles", { filters: { role: "worker", status: "active" }, orderBy: { field: "name", dir: "asc" } }),
    store.list<{ id: string; courier_id: string; name: string }>("flaship_couriers", { filters: { active: true } }),
    store.list<{ id: string; city_id: string; name: string }>("flaship_cities", { filters: { active: true } }),
    store.list<{ id: string; pickup_id: string; name: string; city: string | null }>("flaship_pickups", { filters: { active: true } }),
    getFlashipConfig(),
  ]);
  return ok({
    customers: customers.rows,
    products: products.rows.map((p) => ({ ...p, available_stock: p.current_stock - p.reserved_stock })),
    workers: workers.rows,
    couriers: couriers.rows,
    cities: cities.rows,
    pickups: pickups.rows,
    flaship: { mode: cfg.mode, default_courier: cfg.default_courier ?? null, default_pickup: cfg.default_pickup ?? null },
  });
});
