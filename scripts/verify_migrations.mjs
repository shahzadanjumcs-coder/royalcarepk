// RoyalCarePK — read-only migration verification (0001 + 0002)
// Strictly GET requests only. Prints status codes, names, counts and
// non-secret config values. Never prints keys/tokens.
import { readFileSync } from "node:fs";

const env = {};
for (const line of readFileSync("/home/z/my-project/.env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const SR = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!URL_ || !SR) { console.log("ENV_INCOMPLETE"); process.exit(1); }

const H = (k) => ({ apikey: k, Authorization: `Bearer ${k}` });
const hdrsSR = H(SR), hdrsAnon = H(ANON);

async function getJson(url, headers) {
  const r = await fetch(url, { headers });
  let body = null;
  try { body = await r.json(); } catch { /* ignore */ }
  return { status: r.status, body };
}

const EXPECTED_TABLES = [
  "profiles","teams","team_members","customers","categories","suppliers",
  "products","inventory_movements","orders","order_items","order_status_history",
  "shipments","shipment_tracking","commission_transactions","commission_rules",
  "worker_payments","flaship_couriers","flaship_cities","flaship_pickups",
  "flaship_pickup_couriers","flaship_logs","notifications","audit_logs","settings",
  "whatsapp_accounts","whatsapp_routing_settings","whatsapp_admin_recipients",
  "whatsapp_group_settings","whatsapp_bot_settings","whatsapp_message_queue",
  "whatsapp_message_logs","whatsapp_commands","whatsapp_inbox",
];

console.log("=== 1. TABLES (PostgREST OpenAPI) ===");
{
  const { status, body } = await getJson(`${URL_}/rest/v1/`, hdrsSR);
  const got = new Set(Object.keys(body?.definitions ?? {}));
  const missing = EXPECTED_TABLES.filter((t) => !got.has(t));
  console.log(`http=${status} expected=${EXPECTED_TABLES.length} found=${EXPECTED_TABLES.length - missing.length}`);
  console.log(missing.length ? `MISSING: ${missing.join(", ")}` : "MISSING: none");
}

console.log("=== 2. TRIGGER EVIDENCE (profiles rows) ===");
{
  const { status, body } = await getJson(`${URL_}/rest/v1/profiles?select=role,email,created_at`, hdrsSR);
  if (status === 200 && Array.isArray(body)) {
    const byRole = {};
    for (const p of body) byRole[p.role] = (byRole[p.role] ?? 0) + 1;
    console.log(`http=${status} profile_rows=${body.length} roles=${JSON.stringify(byRole)}`);
    const sa = body.find((p) => (p.email ?? "").toLowerCase() === "royalcarepk@gmail.com");
    console.log(`designated_super_admin_profile=${sa ? "PRESENT (trigger fired for signup)" : "ABSENT (no signup yet — trigger will fire on first signup)"}`);
    if (body.length) {
      const latest = body.map((p) => p.created_at).sort().at(-1);
      console.log(`latest_profile_created_at=${latest}`);
    }
  } else console.log(`http=${status} (unexpected)`);
}

console.log("=== 3/4/5. SETTINGS ROWS (service key) ===");
{
  const { status, body } = await getJson(`${URL_}/rest/v1/settings?select=key,value&order=key.asc`, hdrsSR);
  console.log(`http=${status} rows=${Array.isArray(body) ? body.length : "?"}`);
  for (const row of body ?? []) {
    const v = row.value ?? {};
    if (row.key === "branding") {
      console.log(`branding: brand_name=${v.brand_name} tagline=${v.tagline} primary=${v.primary_color} secondary=${v.secondary_color} logo_url=${v.logo_url ?? "null"}`);
    } else if (row.key === "general") {
      console.log(`general: business_name=${v.business_name} currency=${v.currency} low_stock_threshold=${v.low_stock_threshold}`);
    } else if (row.key === "flaship") {
      console.log(`flaship: endpoints=${JSON.stringify(v.endpoints)}`);
      console.log(`flaship: mode=${v.mode ?? "(legacy)"} default_service_type=${v.default_service_type ?? "(not set)"} timeout_ms=${v.timeout_ms ?? "(not set)"}`);
    } else console.log(`${row.key}: (present)`);
  }
}

console.log("=== 6. BRANDING STORAGE BUCKET ===");
{
  const { status, body } = await getJson(`${URL_}/storage/v1/bucket/branding`, hdrsSR);
  console.log(`http=${status} name=${body?.name} public=${body?.public} file_size_limit=${body?.file_size_limit} mime_types=${(body?.allowed_mime_types ?? []).length}`);
}

console.log("=== 7/8. RLS BEHAVIORAL PROBE (anon must see 0 rows) ===");
for (const t of ["settings", "profiles", "orders", "customers", "commission_transactions", "worker_payments", "audit_logs", "notifications"]) {
  const a = await getJson(`${URL_}/rest/v1/${t}?select=*`, hdrsAnon);
  const s = await getJson(`${URL_}/rest/v1/${t}?select=*`, hdrsSR);
  const aCount = Array.isArray(a.body) ? a.body.length : `http ${a.status}`;
  const sCount = Array.isArray(s.body) ? s.body.length : `http ${s.status}`;
  console.log(`${t}: anon_rows=${aCount} service_rows=${sCount}${a.status !== 200 ? ` (anon http=${a.status})` : ""}`);
}
console.log("NOTE: settings contrast (service sees rows, anon sees 0) proves RLS is active; empty tables cannot be distinguished behaviorally until they hold data.");
