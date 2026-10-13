import { ok, withAuth } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import { getFlashipConfig } from "@/lib/flaship/service";
import { listDealsWithItems } from "@/lib/services/deals";

/** One call to populate create-order form dropdowns. */
export const GET = withAuth(["super_admin", "admin", "worker"], async (session) => {
  // Workers may only see customers + active products for their order form.
  // They must NOT see worker lists, Flaship config or courier defaults.
  if (session.role === "worker") {
    const [customers, products, deals] = await Promise.all([
      store.list<{ id: string; name: string; phone: string; city: string | null; address: string | null }>("customers", { filters: { status: "active" }, orderBy: { field: "name", dir: "asc" } }),
      store.list<{ id: string; name: string; sku: string; selling_price: number; current_stock: number; reserved_stock: number; status: string }>("products", { filters: { status: "active" }, orderBy: { field: "name", dir: "asc" } }),
      listDealsWithItems({ statuses: ["active"] }),
    ]);
    return ok({
      customers: customers.rows,
      products: products.rows.map((p) => ({ ...p, available_stock: p.current_stock - p.reserved_stock })),
      // active deals with live component availability so the order form can
      // show whether the bundle can be fulfilled before submitting
      deals: deals.map((d) => ({
        id: d.id,
        name: d.name,
        description: d.description,
        selling_price: d.selling_price,
        items: d.items.map((it) => ({ product_id: it.product_id, product_name: it.product_name, quantity: it.quantity, available_stock: it.available_stock })),
      })),
    });
  }

  const [customers, products, workers, couriers, cities, pickups, pickupCouriers, deals, cfg] = await Promise.all([
    store.list<{ id: string; name: string; phone: string; city: string | null; address: string | null }>("customers", { filters: { status: "active" }, orderBy: { field: "name", dir: "asc" } }),
    store.list<{ id: string; name: string; sku: string; selling_price: number; current_stock: number; reserved_stock: number; status: string }>("products", { filters: { status: "active" }, orderBy: { field: "name", dir: "asc" } }),
    store.list<{ id: string; name: string; commission_rate: number; status: string }>("profiles", { filters: { role: "worker", status: "active" }, orderBy: { field: "name", dir: "asc" } }),
    store.list<{ id: string; courier_id: string; name: string }>("flaship_couriers", { filters: { active: true } }),
    store.list<{ id: string; city_id: string; name: string }>("flaship_cities", { filters: { active: true } }),
    store.list<{ id: string; pickup_id: string; name: string; city: string | null }>("flaship_pickups", { filters: { active: true } }),
    store.list<{ pickup_id: string; courier_id: string }>("flaship_pickup_couriers"),
    listDealsWithItems({ statuses: ["active"] }),
    getFlashipConfig(),
  ]);
  return ok({
    customers: customers.rows,
    products: products.rows.map((p) => ({ ...p, available_stock: p.current_stock - p.reserved_stock })),
    workers: workers.rows,
    couriers: couriers.rows,
    cities: cities.rows,
    pickups: pickups.rows,
    // pickup↔courier mapping (Flaship merchant_pickup_couriers) — lets the
    // booking UI offer only pickup locations actually enabled for the courier.
    pickup_couriers: pickupCouriers.rows,
    // active deals for the order forms (component availability included)
    deals: deals.map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      selling_price: d.selling_price,
      items: d.items.map((it) => ({ product_id: it.product_id, product_name: it.product_name, quantity: it.quantity, available_stock: it.available_stock })),
    })),
    flaship: { mode: cfg.mode, default_courier: cfg.default_courier ?? null, default_pickup: cfg.default_pickup ?? null },
  });
});
