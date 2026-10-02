// READ-ONLY Flaship configuration verification.
// - Env vars: reports NAME + PRESENT/BLANK/MISSING only. Never prints values.
// - Live DB settings row (key=flaship): prints ONLY non-secret fields
//   (base_url, endpoints, timeout_ms, mode, booleans). Never prints
//   api_key_enc / api_key_masked / any credential material.
import { readFileSync } from "node:fs";

const ENV_PATH = "/home/z/my-project/.env.local";
let env = {};
try {
  env = Object.fromEntries(
    readFileSync(ENV_PATH, "utf8")
      .split("\n")
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i), l.slice(i + 1)];
      })
  );
} catch {
  console.log("ENV: .env.local not readable");
}

function status(name) {
  if (!(name in env)) return "MISSING";
  return env[name].trim().length > 0 ? "PRESENT (non-empty)" : "PRESENT (blank)";
}

console.log("== 1. Environment variables (names only, no values) ==");
for (const n of [
  "FLASHIP_API_KEY",
  "FLASHIP_API_BASE_URL",
  "FLASHIP_ENC_SECRET",
  "SUPABASE_SERVICE_ROLE_KEY",
]) {
  console.log(`${n}: ${status(n)}`);
}
console.log(`FLASHIP_API_BASE_URL value class: ${
  env.FLASHIP_API_BASE_URL
    ? env.FLASHIP_API_BASE_URL.includes("partners.flaship.pk/api/integration")
      ? "matches https://partners.flaship.pk/api/integration"
      : "custom (non-default host/path)"
    : "unset"
}`);

// ---- Live DB check via PostgREST (service role) ----
const base = env.NEXT_PUBLIC_SUPABASE_URL;
const skey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!base || !skey) {
  console.log("\n== 2. Live DB settings row ==\nSKIP — Supabase creds not present in .env.local");
  process.exit(0);
}

console.log("\n== 2. Live DB settings row key='flaship' (non-secret fields only) ==");
const res = await fetch(`${base}/rest/v1/settings?key=eq.flaship&select=key,value,updated_at`, {
  headers: { apikey: skey, Authorization: `Bearer ${skey}` },
});
if (!res.ok) {
  console.log(`HTTP ${res.status} — could not read settings row`);
  process.exit(0);
}
const rows = await res.json();
const v = rows?.[0]?.value ?? {};
const SECRET_KEYS = new Set(["api_key_enc", "api_key_masked"]);
const safe = {};
for (const [k, val] of Object.entries(v)) {
  safe[k] = SECRET_KEYS.has(k) ? (k === "api_key_enc" ? `<${val ? "present" : "empty"}>` : "<redacted>") : val;
}
console.log(JSON.stringify(safe, null, 2));

console.log("\n== 3. Comparison vs code defaults (service.ts) ==");
const CODE_DEFAULTS = {
  base_url: "https://partners.flaship.pk/api/integration",
  endpoints: { catalog: "/catalog/", bookings: "/bookings/", tracking: "/orders/{cn}/tracking/" },
  timeout_ms: 30000,
  default_service_type: "overnight",
  default_weight: 0.5,
};
const dbBase = v.base_url ?? "(not set in DB → falls back to code/env default)";
console.log(`base_url   : DB=${dbBase}`);
console.log(`             code default / env = ${CODE_DEFAULTS.base_url}`);
console.log(`             match: ${String(v.base_url ?? CODE_DEFAULTS.base_url) === CODE_DEFAULTS.base_url ? "YES" : "DIFFERS"}`);
const dbEp = v.endpoints ?? {};
for (const [k, dflt] of Object.entries(CODE_DEFAULTS.endpoints)) {
  const got = dbEp[k] ?? "(not set → default)";
  console.log(`endpoint ${k.padEnd(9)}: DB=${got}  code=${dflt}  match: ${String(dbEp[k] ?? dflt) === dflt ? "YES" : "DIFFERS"}`);
}
console.log(`timeout_ms : DB=${v.timeout_ms ?? "(not set → default 30000)"}  code=30000`);
console.log(`api_key_enc present in DB: ${v.api_key_enc ? "YES (encrypted at rest)" : "NO"}`);
console.log(`mode in DB: ${v.mode ?? "(not set)"}`);

console.log("\nDONE — read-only, nothing modified, no secret values printed.");
