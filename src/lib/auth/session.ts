import { cookies } from "next/headers";
import type { Role, Session } from "@/lib/types";
import { IS_DEMO_MODE } from "@/lib/store";

export const SESSION_COOKIE = "co_session";

const SECRET = process.env.DEMO_AUTH_SECRET || "royalcarepk-demo-secret-key-change-in-production";

// ---------------- Token helpers (Web Crypto — edge + node compatible) ----------------

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmac(data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64urlEncode(new Uint8Array(sig));
}

export interface TokenPayload {
  userId: string;
  email: string;
  name: string;
  role: Role;
  mode: "demo" | "supabase";
}

export async function signToken(payload: TokenPayload): Promise<string> {
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmac(body);
  return `${body}.${sig}`;
}

export async function verifyToken(token: string | undefined | null): Promise<TokenPayload | null> {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = await hmac(body);
  if (expected !== sig) return null;
  try {
    const json = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as TokenPayload;
    return json;
  } catch {
    return null;
  }
}

// ---------------- Server-side session access ----------------

/** Get the current session (demo cookie or Supabase Auth), or null. */
export async function getSession(): Promise<Session | null> {
  if (IS_DEMO_MODE) {
    const cookieStore = await cookies();
    const token = cookieStore.get(SESSION_COOKIE)?.value;
    const payload = await verifyToken(token);
    if (!payload) return null;
    return { ...payload, mode: "demo" };
  }
  // Supabase mode
  try {
    const { getServerClient } = await import("@/lib/supabase/server");
    const supabase = await getServerClient();
    const { data } = await supabase.auth.getUser();
    if (!data.user) return null;
    const { data: profile } = await supabase
      .from("profiles")
      .select("name, email, role, status")
      .eq("id", data.user.id)
      .single();
    if (!profile || profile.status !== "active") return null;
    return {
      userId: data.user.id,
      email: profile.email ?? data.user.email ?? "",
      name: profile.name ?? "User",
      role: profile.role as Role,
      mode: "supabase",
    };
  } catch {
    return null;
  }
}
