/**
 * Verification: bulk-upsert catalog sync (duplicate-key fix).
 *
 * Isolation:
 *  - Demo memory store in a scratch cwd → live Supabase never touched.
 *  - syncCatalog runs in SIMULATOR mode (no api key stored) → it reads the
 *    catalog from the store itself. ZERO Flaship API calls.
 *  - Scale test uses 1,500 pre-seeded cities (> the ~1,000 PostgREST cap that
 *    caused the duplicate-key bug) to prove the new path is size-immune.
 *  - No secrets involved; no values printed besides counts/booleans.
 */

// isolation before any app import
process.env.NEXT_PUBLIC_SUPABASE_URL = "";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "";
process.env.SUPABASE_SERVICE_ROLE_KEY = "";
process.env.FLASHIP_API_KEY = "";

const bunGlobal = (globalThis as unknown as { Bun?: { plugin: (p: unknown) => void } }).Bun;
if (bunGlobal) {
  bunGlobal.plugin({
    name: "verify-shims",
    setup(build: { module: (id: string, f: () => unknown) => void }) {
      build.module("server-only", () => ({ exports: {}, loader: "object" }));
      build.module("next/headers", () => ({ exports: { cookies: () => { throw new Error("no request scope"); } }, loader: "object" }));
    },
  });
}

type Result = { id: string; name: string; pass: boolean; detail: string };
const results: Result[] = [];
function record(id: string, name: string, pass: boolean, detail = "") {
  results.push({ id, name, pass, detail });
}
export {}; // module scope (avoids cross-script global collisions under tsc)

async function main() {
  const { IS_DEMO_MODE, store } = await import("../src/lib/store");
  const { syncCatalog } = await import("../src/lib/flaship/service");

  record("T0", "isolated demo store active", IS_DEMO_MODE === true, `IS_DEMO_MODE=${IS_DEMO_MODE}`);

  // ---- seed 1,500 cities + 11 couriers + 1 pickup (pre-existing catalog state) ----
  const cities: Record<string, unknown>[] = [];
  for (let i = 0; i < 1500; i++) {
    cities.push({ __table: "flaship_cities", city_id: `verify_city_${i}`, name: `Verify City ${i}`, province: null, active: true, synced_at: null });
  }
  const couriers: Record<string, unknown>[] = [];
  for (let i = 0; i < 11; i++) {
    couriers.push({ __table: "flaship_couriers", courier_id: `verify_courier_${i}`, name: `Verify Courier ${i}`, active: true, synced_at: null });
  }
  const pickups: Record<string, unknown>[] = [{ __table: "flaship_pickups", pickup_id: "verify_pickup_1", name: "Verify Pickup 1", address: null, city: null, contact: null, active: true, synced_at: null }];

  const db = [...cities, ...couriers, ...pickups];
  // insert via the store's public API into the memory adapter
  const { memoryStore: mem } = await import("../src/lib/store");
  for (const r of db) {
    const { __table, ...row } = r;
    await mem.insert(__table as "flaship_cities", row);
  }
  record("T0b", "seeded 1500 cities / 11 couriers / 1 pickup", true, "memory store pre-populated");

  const snapshotBefore = await mem.list<Record<string, unknown>>("flaship_cities");
  const beforeCount = snapshotBefore.rows.length;
  const verifyCity0Before = snapshotBefore.rows.find((r) => r.city_id === "verify_city_0");
  const verifyCity0IdBefore = verifyCity0Before?.id;
  const couriersBefore = (await mem.list<Record<string, unknown>>("flaship_couriers")).rows.length;
  const pickupsBefore = (await mem.list<Record<string, unknown>>("flaship_pickups")).rows.length;

  // ---- sync #1 (the previously-failing refresh at >1000 scale) ----
  const counts1 = await syncCatalog("all");
  const after1 = await mem.list<Record<string, unknown>>("flaship_cities");
  const afterCouriers1 = await mem.list<Record<string, unknown>>("flaship_couriers");
  const afterPickups1 = await mem.list<Record<string, unknown>>("flaship_pickups");
  const cityIds1 = after1.rows.map((r) => String(r.city_id));
  const uniqueCityIds1 = new Set(cityIds1);

  record("T1", "sync #1 completes at 1500+ scale", true, `counts=${JSON.stringify(counts1)}`);
  record("T1a", "cities count stable (no duplicate growth)", after1.rows.length === beforeCount, `before=${beforeCount}, after=${after1.rows.length}`);
  record("T1b", "all city_id values unique after sync", cityIds1.length === uniqueCityIds1.size, `rows=${cityIds1.length}, unique=${uniqueCityIds1.size}`);
  record("T1c", "existing rows merged in place (id preserved)", verifyCity0IdBefore !== undefined && after1.rows.some((r) => r.id === verifyCity0IdBefore && r.city_id === "verify_city_0"), `verify_city_0 id unchanged=${after1.rows.some((r) => r.id === verifyCity0IdBefore)}`);
  record("T1d", "synced_at refreshed on merged rows", after1.rows.every((r) => !!r.synced_at), `all synced_at set=${after1.rows.every((r) => !!r.synced_at)}`);
  record("T1e", "couriers/pickups synced without growth", afterCouriers1.rows.length === couriersBefore && afterPickups1.rows.length === pickupsBefore && new Set(afterCouriers1.rows.map((r) => String(r.courier_id))).size === afterCouriers1.rows.length, `couriers=${afterCouriers1.rows.length}/${couriersBefore}, pickups=${afterPickups1.rows.length}/${pickupsBefore}, courier_ids unique`);

  // ---- sync #2 (the repeat refresh that used to crash with duplicate key) ----
  const counts2 = await syncCatalog("all");
  const after2 = await mem.list<Record<string, unknown>>("flaship_cities");
  const cityIds2 = after2.rows.map((r) => String(r.city_id));
  record("T2", "sync #2 (repeat) idempotent — no duplicate-key error", after2.rows.length === beforeCount, `count=${after2.rows.length} (expected ${beforeCount}), unique=${new Set(cityIds2).size === cityIds2.length}`);

  // ---- direct upsertMany semantics: update-in-place + insert-new ----
  await mem.upsertMany("flaship_cities", [{ city_id: "verify_city_0", name: "Verify City 0 RENAMED", province: "Sindh", active: true, synced_at: "2026-01-01T00:00:00Z" }], ["city_id"]);
  await mem.upsertMany("flaship_cities", [{ city_id: "verify_city_new", name: "Verify City NEW", province: null, active: true, synced_at: "2026-01-01T00:00:00Z" }], ["city_id"]);
  const after3 = await mem.list<Record<string, unknown>>("flaship_cities");
  const renamed = after3.rows.find((r) => r.city_id === "verify_city_0");
  const inserted = after3.rows.find((r) => r.city_id === "verify_city_new");
  record("T3", "upsert merges existing row (name updated, same id)", !!renamed && renamed.name === "Verify City 0 RENAMED" && renamed.id === verifyCity0IdBefore, `renamed=${renamed?.name === "Verify City 0 RENAMED"}, sameId=${renamed?.id === verifyCity0IdBefore}`);
  record("T4", "upsert inserts missing row", !!inserted, `inserted=${!!inserted}`);
  // insert path proven by T4; final sync must stay idempotent at whatever the
  // store now holds (1512 seed+verify + 1 inserted)
  const counts4 = await syncCatalog("all");
  const after4 = await mem.list<Record<string, unknown>>("flaship_cities");
  const ids4 = after4.rows.map((r) => String(r.city_id));
  record("T5", "final sync idempotent at post-T4 count", after4.rows.length === after3.rows.length && new Set(ids4).size === ids4.length, `count=${after4.rows.length} (pre-sync ${after3.rows.length}), unique=${new Set(ids4).size === ids4.length}, counts=${JSON.stringify(counts4)}`);

  // ---- flaship_cities: no Flaship request was possible in simulator mode ----
  // (syncCatalog only calls liveRequest when cfg.mode === "live"; demo store has no key)
  const cfgRow = await store.first("settings", { key: "flaship" });
  const mode = (cfgRow?.value as { mode?: string })?.mode;
  record("T6", "ran in simulator mode (no Flaship calls possible)", mode === "simulator", `settings.flaship.mode=${mode}`);

  let failed = 0;
  for (const r of results) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id.padEnd(4)} ${r.name}${r.detail ? `  — ${r.detail}` : ""}`);
  }
  console.log(`\nRESULT: ${failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("VERIFICATION CRASHED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
