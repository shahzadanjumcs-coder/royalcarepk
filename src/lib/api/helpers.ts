import { NextResponse } from "next/server";
import type { Role, Session } from "@/lib/types";
import { getSession } from "@/lib/auth/session";
import type { ListOptions } from "@/lib/store/base";

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

export function fail(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export const GENERIC_ERROR = "Something went wrong. Please try again.";

/**
 * Strip credential material (password hashes) before any profile row is
 * returned to the browser. Password hashes must never leave the server.
 */
export function sanitizeProfile<T extends object>(profile: T): T {
  if (profile && typeof profile === "object" && "password_hash" in profile) {
    const copy = { ...(profile as Record<string, unknown>) };
    delete copy.password_hash;
    return copy as T;
  }
  return profile;
}

/**
 * Whitelist client-supplied PATCH bodies down to known columns before they
 * reach store.update — an unexpected key would otherwise surface as a
 * PostgREST PGRST204 "column not found" 500 (raw spreads on teams, customers,
 * categories, suppliers and commission_rules did exactly that).
 */
export function pickFields(body: Record<string, unknown>, allowed: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) out[key] = body[key];
  }
  return out;
}

/**
 * Wraps a route handler with authentication + optional role enforcement.
 */
export function withAuth(
  roles: Role[] | "any",
  handler: (session: Session, req: Request, ctx: Record<string, unknown>) => Promise<Response>
) {
  return async (req: Request, ctx: Record<string, unknown> = {}): Promise<Response> => {
    try {
      const session = await getSession();
      if (!session) return fail("You must sign in to continue.", 401);
      if (roles !== "any" && !roles.includes(session.role)) {
        return fail("You do not have permission to perform this action.", 403);
      }
      return await handler(session, req, ctx);
    } catch (err) {
      console.error("[api]", err);
      const message = err instanceof Error ? err.message : GENERIC_ERROR;
      // Hide raw DB errors from clients
      return fail(/duplicate key/i.test(message) ? "A record with these details already exists." : GENERIC_ERROR, 500);
    }
  };
}

export function parseListParams(url: URL, dateField = "created_at", searchFields: string[] = []): ListOptions & { page: number; perPage: number } {
  const sp = url.searchParams;
  const page = Math.max(1, parseInt(sp.get("page") || "1", 10) || 1);
  const perPage = Math.min(100, Math.max(5, parseInt(sp.get("perPage") || "15", 10) || 15));
  const opts: ListOptions & { page: number; perPage: number } = {
    page,
    perPage,
    filters: {},
  };
  const q = sp.get("search");
  if (q && searchFields.length) opts.search = { q, fields: searchFields };
  const status = sp.get("status");
  if (status) opts.filters!.status = status;
  const from = sp.get("from");
  const to = sp.get("to");
  if (from || to) opts.dateRange = { field: dateField, from, to };
  const orderBy = sp.get("orderBy") || dateField;
  const orderDir = (sp.get("orderDir") as "asc" | "desc") || "desc";
  opts.orderBy = { field: orderBy, dir: orderDir };
  // extra equality filters declared as f_<field>=<value>
  sp.forEach((value, key) => {
    if (key.startsWith("f_") && value) opts.filters![key.slice(2)] = value;
  });
  return opts;
}
