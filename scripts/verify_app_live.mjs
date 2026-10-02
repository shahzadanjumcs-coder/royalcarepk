// RoyalCarePK — READ-ONLY live application verification (no data changes except
// the inherent side effects of a magic-link sign-in: a session row + last_sign_in_at).
// Never prints tokens, cookie values, keys, or .env contents.
import { readFileSync, writeFileSync, chmodSync } from "node:fs";

const env = {};
for (const line of readFileSync("/home/z/my-project/.env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const SR = env.SUPABASE_SERVICE_ROLE_KEY;
const APP = "http://localhost:3000";
const REF = URL_.replace(/^https?:\/\//, "").split(".")[0];
const ADMIN_EMAIL = "royalcarepk@gmail.com";

const results = [];
const report = (name, pass, evidence) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} | ${name} | ${evidence}`);
};

async function j(url, opts = {}) {
  const r = await fetch(url, opts);
  let b = null;
  try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
}

// ---------- 1. App reachable ----------
{
  const r = await fetch(`${APP}/login`);
  const html = await r.text();
  report("1. app_starts", r.status === 200 && html.length > 500, `GET /login -> ${r.status}, html ${html.length}B`);
}

// ---------- 2. Supabase connection via app (public branding read, live mode) ----------
{
  const { status, body } = await j(`${APP}/api/branding`);
  const bn = (body?.branding ?? body?.data?.branding)?.brand_name;
  const tag = (body?.branding ?? body?.data?.branding)?.tagline;
  report("2+6. supabase_conn_branding", status === 200 && bn === "RoyalCarePK", `GET /api/branding -> ${status}, brand_name=${bn}, tagline=${tag}`);
}

// ---------- 3. Admin user check ----------
let userIdShort = "?";
{
  const { status, body } = await j(`${URL_}/auth/v1/admin/users?page=1&per_page=50`, { headers: { apikey: SR, Authorization: `Bearer ${SR}` } });
  const users = body?.users ?? [];
  const u = users.find((x) => (x.email ?? "").toLowerCase() === ADMIN_EMAIL);
  userIdShort = u ? String(u.id).slice(0, 8) : "?";
  report("3a. super_admin_account_exists", !!u, `admin users -> ${status}, found=${!!u}, confirmed=${u?.email_confirmed_at ? "yes" : "no"}, last_sign_in_at=${u?.last_sign_in_at ?? "never"}`);
}

// ---------- 4. Magic-link sign-in (password never used; tokens never printed) ----------
let session = null;
{
  const gl = await j(`${URL_}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", email: ADMIN_EMAIL }),
  });
  const actionLink = gl.body?.action_link ?? gl.body?.properties?.action_link;
  if (gl.status === 200 && actionLink) {
    const params = new URL(actionLink).searchParams;
    const linkToken = params.get("token") ?? params.get("token_hash");
    const hashed = gl.body?.hashed_token ?? linkToken;
    const attempts = [
      { type: "magiclink", token_hash: hashed },
      { type: "magiclink", token: hashed },
    ];
    let lastErr = "";
    for (const payload of attempts) {
      const v = await j(`${URL_}/auth/v1/verify`, {
        method: "POST",
        headers: { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (v.status === 200 && v.body?.access_token) { session = v.body; break; }
      lastErr = v.body?.msg ?? v.body?.error_description ?? v.body?.error ?? v.body?.code ?? `http ${v.status}`;
    }
    // Fallback: GET the action link (the way a real magic link works) and read
    // the redirect chain internally — tokens parsed but never printed.
    if (!session) {
      try {
        let loc = actionLink;
        let fragTokens = null;
        for (let i = 0; i < 6 && loc; i++) {
          const r = await fetch(loc, { redirect: "manual" });
          const next = r.headers.get("location");
          if (!next) break;
          const u = new URL(next, loc.startsWith("http") ? loc : URL_);
          const h = new URLSearchParams((u.hash ?? "").replace(/^#/, ""));
          if (h.get("access_token")) { fragTokens = { access_token: h.get("access_token"), refresh_token: h.get("refresh_token"), expires_in: Number(h.get("expires_in") ?? 3600) }; break; }
          loc = u.toString();
        }
        if (fragTokens) {
          const me = await j(`${URL_}/auth/v1/user`, { headers: { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY, Authorization: `Bearer ${fragTokens.access_token}` } });
          if (me.status === 200 && me.body?.id) {
            session = {
              access_token: fragTokens.access_token,
              refresh_token: fragTokens.refresh_token,
              token_type: "bearer",
              expires_in: fragTokens.expires_in,
              expires_at: Math.floor(Date.now() / 1000) + fragTokens.expires_in,
              user: me.body,
            };
          }
        } else { lastErr = lastErr || "no redirect fragment captured"; }
      } catch (e) { lastErr = lastErr || "redirect-flow error"; }
    }
    if (!session) console.log(`VERIFY_DEBUG: ${lastErr}`);
  } else {
    console.log(`GEN_LINK_DEBUG: http=${gl.status} msg=${gl.body?.msg ?? gl.body?.error_description ?? gl.body?.error ?? gl.body?.code ?? "?"}`);
  }
  report("3b. sign_in_works", !!session, session ? `magic-link sign-in OK for ${ADMIN_EMAIL} (session obtained; a session row + last_sign_in_at update are inherent sign-in side effects)` : `magic-link verify failed`);
}

// ---------- 5. As-user RLS checks (Bearer = the real user identity) ----------
if (session) {
  const H = { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` };
  const p = await j(`${URL_}/rest/v1/profiles?id=eq.${session.user.id}&select=role,email,name,status`, { headers: H });
  const prof = p.body?.[0];
  report("4a. role_supabase_level", p.status === 200 && prof?.role === "super_admin", `profiles as user -> ${p.status}, role=${prof?.role}, status=${prof?.status}`);

  for (const t of ["settings", "categories", "products", "customers", "orders", "notifications", "audit_logs"]) {
    const r = await j(`${URL_}/rest/v1/${t}?select=*`, { headers: H });
    const n = Array.isArray(r.body) ? r.body.length : "?";
    report(`7a. rls_read_${t}`, r.status === 200, `as super_admin -> ${r.status}, rows=${n}`);
  }
}

// ---------- 6. Craft @supabase/ssr cookie + app-level API checks ----------
let cookieFile = null;
if (session) {
  const cookieName = `sb-${REF}-auth-token`;
  const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64");
  cookieFile = "/home/z/my-project/data/.verify-session.cookie";
  writeFileSync(cookieFile, `${cookieName}=${value}`);
  chmodSync(cookieFile, 0o600);
  const COOKIE = `${cookieName}=${value}`;

  const s = await j(`${APP}/api/auth/session`, { headers: { cookie: COOKIE } });
  const sess = s.body?.session ?? s.body?.data?.session;
  const role = sess?.role;
  const mode = s.body?.mode ?? s.body?.data?.mode;
  const email = sess?.email;
  report("4b. role_app_level", s.status === 200 && role === "super_admin", `GET /api/auth/session -> ${status0(s)}, mode=${mode}, role=${role}, email=${email}`);

  const b = await j(`${APP}/api/branding`, { headers: { cookie: COOKIE } });
  report("6a. branding_authenticated", b.status === 200 && (b.body?.branding ?? b.body?.data?.branding)?.brand_name === "RoyalCarePK", `GET /api/branding -> ${status0(b)}`);

  for (const ep of ["settings", "categories", "products", "customers", "orders", "notifications", "dashboard", "users", "audit-logs"]) {
    const r = await j(`${APP}/api/${ep}`, { headers: { cookie: COOKIE } });
    let detail = "";
    const scan = (o, pre) => {
      for (const [k, v] of Object.entries(o ?? {})) {
        if (Array.isArray(v)) detail += `${pre}${k}[${v.length}] `;
        else if (v && typeof v === "object" && detail.length < 160) scan(v, `${pre}${k}.`);
      }
    };
    scan(r.body, "");
    if (!detail) detail = `keys=${Object.keys(r.body ?? {}).slice(0, 8).join("|")}`;
    report(`7b. app_read_${ep}`, r.status === 200, `GET /api/${ep} -> ${status0(r)} ${detail}`);
  }
  console.log(`COOKIE_NAME=${cookieName} (value kept in ${cookieFile}, never printed)`);
}

function status0(r) { return r.status; }

console.log("\nSUMMARY: " + results.filter((r) => r.pass).length + "/" + results.length + " PASS");
for (const r of results.filter((r) => !r.pass)) console.log(`FAILED: ${r.name}`);
