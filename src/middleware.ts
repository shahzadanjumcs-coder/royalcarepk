import { NextRequest, NextResponse } from "next/server";

const PROTECTED_PREFIXES = ["/admin", "/worker"];
const AUTH_PAGES = ["/login", "/signup", "/forgot-password", "/reset-password"];

const SECRET = process.env.DEMO_AUTH_SECRET || "royalcarepk-demo-secret-key-change-in-production";

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Verify the demo session cookie signature (HMAC-SHA256) using Web Crypto. */
async function hasValidSessionCookie(req: NextRequest): Promise<boolean> {
  // Supabase SSR auth cookies are prefixed with sb-; presence is enough here
  // because Supabase itself validates the JWT on every server call.
  if (req.cookies.getAll().some((c) => c.name.startsWith("sb-"))) return true;
  const token = req.cookies.get("co_session")?.value;
  if (!token) return false;
  const [body, sig] = token.split(".");
  if (!body || !sig) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const expected = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    return b64urlEncode(new Uint8Array(expected)) === sig;
  } catch {
    return false;
  }
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const authed = await hasValidSessionCookie(req);

  // Protected areas: bounce to login (role refinement happens in server layouts).
  // Invalid/stale cookies are treated as unauthenticated so the user can reach
  // the login page instead of being trapped in a redirect loop.
  if (!authed && PROTECTED_PREFIXES.some((p) => pathname.startsWith(p))) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // Valid sessions skip the auth pages
  if (authed && AUTH_PAGES.some((p) => pathname.startsWith(p))) {
    const url = req.nextUrl.clone();
    url.pathname = "/admin";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/worker/:path*", "/login", "/signup", "/forgot-password", "/reset-password"],
};
