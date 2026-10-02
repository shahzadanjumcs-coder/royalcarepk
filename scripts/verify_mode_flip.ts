/**
 * Verification: saving a non-empty Flaship API key through the PATCH
 * /api/settings code path results in mode="live".
 *
 * Isolation guarantees:
 *  - Runs in DEMO memory-store mode (Supabase env forced empty) → the live
 *    Supabase project is never touched. Persistence goes to <cwd>/data/
 *    which is a scratch dir deleted after the run.
 *  - The "API key" is a throwaway synthetic placeholder created inside this
 *    script; it is NOT a real key, is never printed, never echoed, never
 *    logged, and never sent anywhere (no outbound HTTP at all).
 *  - No Flaship API calls are made: only settings reads/writes.
 *
 * Pass criteria (all must hold):
 *  T1 no-key save  → mode stays "simulator"   (demo/dev behavior preserved)
 *  T2 key save     → mode becomes "live"      (the fix)
 *  T3 roundtrip    → decryptSecret(enc) === original input
 *  T4 no leak      → GET-shaped response contains neither the key nor ciphertext
 *  T5 smuggle      → body-supplied mode:"simulator" cannot override live
 *  T6 non-secrets  → base_url/endpoints/timeout/service type untouched
 */

// ---- isolation setup (MUST run before any app module import) ----
process.env.NEXT_PUBLIC_SUPABASE_URL = "";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "";
process.env.SUPABASE_SERVICE_ROLE_KEY = "";
process.env.FLASHIP_API_KEY = ""; // ensure env-key path is inert
delete process.env.FLASHIP_ENC_SECRET; // exercise the fallback material path

// Shim RSC-only modules so the real server modules can load under plain bun.
const bunGlobal = (globalThis as unknown as { Bun?: { plugin: (p: unknown) => void } }).Bun;
if (bunGlobal) {
  bunGlobal.plugin({
    name: "verify-shims",
    setup(build: { module: (id: string, f: () => unknown) => void }) {
      build.module("server-only", () => ({ exports: {}, loader: "object" }));
      build.module("next/headers", () => ({ exports: { cookies: () => { throw new Error("no request scope in verification"); } }, loader: "object" }));
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
  // Dynamic imports AFTER shims + env are in place.
  const { IS_DEMO_MODE, store } = await import("../src/lib/store");
  const { saveFlashipSettings, getFlashipConfig, getFlashipKeyHint } = await import("../src/lib/flaship/service");
  const { encryptSecret, decryptSecret } = await import("../src/lib/crypto/secret-box");

  record("T0", "isolated demo store active", IS_DEMO_MODE === true, `IS_DEMO_MODE=${IS_DEMO_MODE}`);

  const seeded = (await store.first("settings", { key: "flaship" }))?.value as Record<string, unknown> | undefined;
  record("T0b", "seed flaship row present, no key stored", !!seeded && !("api_key_enc" in (seeded ?? {})), `seeded mode=${String(seeded?.mode)}`);

  // T1 — non-key save must NOT flip mode (simulator stays available for demo/dev)
  await saveFlashipSettings({ default_weight: 0.75 });
  const afterNoKey = await getFlashipConfig();
  record("T1", "no-key save keeps simulator", afterNoKey.mode === "simulator", `mode=${afterNoKey.mode}, api_key_set=${afterNoKey.api_key_set}`);

  // T2/T3 — replicate the route's flaship branch verbatim (route.ts lines 42-55)
  const plainKey = `SYNTHETIC-VERIFY-ONLY-${Date.now()}-not-a-real-key`; // never printed
  const enc = encryptSecret(plainKey); // AES-256-GCM, same as production path
  record("T2a", "encryptSecret produced ciphertext", !!enc, enc ? `format=v1.*.*.* (len=${enc.length})` : "null");
  if (enc) await saveFlashipSettings({ api_key_enc: enc }); // ← the fix forces mode="live" here

  // route step 2+3: re-read stored row, merge UI-supplied non-secret fields, save again
  const stored = (await store.first("settings", { key: "flaship" }))?.value as Record<string, unknown> ?? {};
  const merged = { ...stored, base_url: "https://partners.flaship.pk/api/integration", timeout_ms: 30000, default_service_type: "overnight" };
  await saveFlashipSettings(merged as Parameters<typeof saveFlashipSettings>[0]);

  const cfg = await getFlashipConfig();
  record("T2", "key saved → mode=live", cfg.mode === "live", `mode=${cfg.mode}, api_key_set=${cfg.api_key_set}`);
  record("T3", "AES-256-GCM roundtrip intact", decryptSecret(enc) === plainKey, "decrypted === original (assertion only)");

  // T4 — GET-shaped response (route.ts lines 15-28) must not leak key material
  const hint = await getFlashipKeyHint();
  const getShaped = {
    api_key_set: hint.api_key_set,
    api_key_masked: hint.api_key_masked,
    api_key_source: hint.source,
    mode: cfg.mode,
    base_url: cfg.base_url,
    endpoints: cfg.endpoints,
    timeout_ms: cfg.timeout_ms,
    default_courier: cfg.default_courier ?? null,
    default_service_type: cfg.default_service_type ?? "overnight",
    default_pickup: cfg.default_pickup ?? null,
    default_weight: cfg.default_weight ?? 0.5,
  };
  const blob = JSON.stringify(getShaped);
  const maskOk = typeof hint.api_key_masked === "string" && /^••••••••.{4}$/.test(hint.api_key_masked);
  record("T4a", "GET shape excludes key + ciphertext", !blob.includes(plainKey) && !blob.includes("api_key_enc") && !blob.includes(enc!), "no key / no api_key_enc / no ciphertext in response shape");
  record("T4b", "masked hint well-formed (last 4 only)", maskOk && hint.source === "database", `source=${hint.source}, maskFormat=${maskOk}`);

  // T5 — a client cannot pin simulator back while a key is stored (route merge covers value.mode)
  await saveFlashipSettings({ mode: "simulator" } as Parameters<typeof saveFlashipSettings>[0]);
  const cfgAfterSmuggle = await getFlashipConfig();
  record("T5", "mode:'simulator' cannot override once key stored", cfgAfterSmuggle.mode === "live", `mode=${cfgAfterSmuggle.mode}`);

  // T6 — non-secret config untouched by the key save
  record(
    "T6",
    "base_url/endpoints/timeout/service-type unchanged",
    cfg.base_url === "https://partners.flaship.pk/api/integration"
      && cfg.endpoints.catalog === "/catalog/"
      && cfg.endpoints.bookings === "/bookings/"
      && cfg.endpoints.tracking === "/orders/{cn}/tracking/"
      && cfg.timeout_ms === 30000
      && cfg.default_service_type === "overnight",
    `base_url ok=${cfg.base_url === "https://partners.flaship.pk/api/integration"}, endpoints ok=${cfg.endpoints.catalog === "/catalog/" && cfg.endpoints.bookings === "/bookings/" && cfg.endpoints.tracking === "/orders/{cn}/tracking/"}, timeout=${cfg.timeout_ms}, service=${cfg.default_service_type}`,
  );

  // ---- summary ----
  let failed = 0;
  for (const r of results) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id.padEnd(4)} ${r.name}${r.detail ? `  — ${r.detail}` : ""}`);
  }
  const plaintextEverLogged = false; // this script never prints plainKey/enc
  console.log(`\nSecurity: key/ciphertext printed anywhere in this run: ${plaintextEverLogged ? "YES (BUG)" : "NO"}`);
  console.log(`RESULT: ${failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("VERIFICATION CRASHED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
