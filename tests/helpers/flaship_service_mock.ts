/// <reference types="bun-types" />
/**
 * Shared Flaship service mock — ONE authoritative fake used by every route-
 * level test file that mocks "@/lib/flaship/service".
 *
 * Why this exists: bun applies mock.module registrations process-globally and
 * named-import bindings re-resolve against the LATEST registration at access
 * time. When two test files mock the same module with DIFFERENT shapes, the
 * file whose mocks register later silently breaks the earlier file's route
 * modules (missing named exports at call time → SyntaxError "Export named …
 * not found"). This was a real suite failure: production_audit.test.ts and
 * flaship_routes.test.ts both mocked the service with disjoint shapes.
 *
 * Sharing ONE factory with the COMPLETE public surface of
 * src/lib/flaship/service.ts (plus a shared call recorder) makes every
 * registration identical, so registration order no longer matters.
 */

/** Shared error class so `instanceof FlashipError` stays consistent everywhere. */
export class SharedFlashipError extends Error {}

/** Every service call made through the mock (each test file filters by fn). */
export const flashipServiceCalls: { fn: string; args: unknown[] }[] = [];

/** Per-test configurables (mutate in beforeEach / individual tests). */
export const flashipServiceStubs: {
  testConnection: { ok: boolean; message: string; mode: string };
} = {
  testConnection: { ok: true, message: "Connected. Catalog loaded: 3 courier(s).", mode: "live" },
};

/** Reset shared state between tests (call from beforeEach). */
export function resetFlashipServiceMock(): void {
  flashipServiceCalls.length = 0;
  flashipServiceStubs.testConnection = { ok: true, message: "Connected. Catalog loaded: 3 courier(s).", mode: "live" };
}

/**
 * Build the complete mock namespace. Covers every runtime export of
 * src/lib/flaship/service.ts so ANY route module's named imports resolve
 * regardless of which test file's registration is active.
 */
export function buildFlashipServiceMock() {
  const record = (fn: string, args: unknown[]) => {
    flashipServiceCalls.push({ fn, args });
  };
  return {
    FlashipError: SharedFlashipError,
    getFlashipConfig: async () => ({
      mode: "live" as const,
      api_key_set: true,
      base_url: "https://partners.flaship.pk/api/integration",
      timeout_ms: 30000,
      default_courier: "Leopard",
      default_pickup: "PK-9012",
    }),
    saveFlashipSettings: async () => undefined,
    getFlashipKeyHint: async () => ({ api_key_set: true, api_key_masked: "\u2022\u2022\u2022\u2022test", source: "env" as const }),
    testFlashipConnection: async (...args: unknown[]) => {
      record("testFlashipConnection", args);
      return { ...flashipServiceStubs.testConnection };
    },
    syncCatalog: async (...args: unknown[]) => {
      record("syncCatalog", args);
      return { couriers: 0, cities: 0, pickups: 0, links: 0 };
    },
    listCouriers: async () => [],
    listCities: async () => [],
    listPickups: async () => [],
    bookOrderWithFlaship: async (...args: unknown[]) => {
      record("bookOrderWithFlaship", args);
      return { bookingId: "FB-TEST", trackingNumber: "FLP-TEST-1", courierName: "Leopard" };
    },
    syncOrderTracking: async (...args: unknown[]) => {
      record("syncOrderTracking", args);
      return { cn: "FLP1", status: "DELIVERED", changes: [] };
    },
    normalizePkPhone: (phone: string) => phone,
  };
}
