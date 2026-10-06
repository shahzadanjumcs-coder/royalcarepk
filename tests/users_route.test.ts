/// <reference types="bun-types" />
/**
 * POST /api/users — live (Supabase) mode regression test.
 *
 * Production bug found by the final audit: the route unconditionally inserted
 * password_hash into profiles (no such column in Supabase) with a random uuid
 * id (violates profiles.id → auth.users FK) → Super Admin "create user" 500'd
 * in live mode. Fixed to mirror the workers route: auth user via service-role
 * admin API, then a profile UPDATE — never a password_hash column write.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";

type SessionShape = { role: string; user_id: string } | null;
let mockSession: SessionShape = { role: "super_admin", user_id: "u-admin" };
mock.module("@/lib/auth/session", () => ({ getSession: async () => mockSession }));

mock.module("@/lib/services/audit", () => ({ logAudit: async () => undefined }));

const insertCalls: { table: string; payload: Record<string, unknown> }[] = [];
mock.module("@/lib/store", () => ({
  IS_DEMO_MODE: false, // force the live branch
  store: {
    first: async () => null, // no duplicate email
    insert: async (table: string, payload: Record<string, unknown>) => {
      insertCalls.push({ table, payload });
      return { id: "should-not-happen", ...payload };
    },
    list: async () => ({ rows: [], total: 0 }),
  },
}));

const adminCalls: { createUser: unknown; updatePayload: unknown } = { createUser: null, updatePayload: null };
mock.module("@/lib/supabase/server", () => ({
  getServiceRoleClient: () => ({
    auth: {
      admin: {
        createUser: async (args: unknown) => {
          adminCalls.createUser = args;
          return { data: { user: { id: "auth-user-1" } }, error: null };
        },
      },
    },
    from: () => ({
      update: (payload: unknown) => {
        adminCalls.updatePayload = payload;
        return { eq: async () => ({ error: null }) };
      },
    }),
  }),
}));

const { POST } = await import("../src/app/api/users/route");

beforeEach(() => {
  mockSession = { role: "super_admin", user_id: "u-admin" };
  insertCalls.length = 0;
  adminCalls.createUser = null;
  adminCalls.updatePayload = null;
});

const postJSON = (payload: unknown) =>
  new Request("http://x/api/users", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
  });

describe("POST /api/users (live Supabase mode)", () => {
  it("creates the auth user via the service-role admin API and never writes password_hash", async () => {
    const res = await POST(
      postJSON({ name: "New Admin", email: "admin2@rc.pk", phone: "03001112222", password: "secret123", role: "admin", commission_rate: 0 })
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "auth-user-1" });
    expect(adminCalls.createUser).toBeTruthy();
    const created = adminCalls.createUser as { email: string; email_confirm: boolean };
    expect(created.email).toBe("admin2@rc.pk");
    expect(created.email_confirm).toBe(true);
    // profile update carries the editable fields — and NO password_hash
    const upd = adminCalls.updatePayload as Record<string, unknown>;
    expect(upd.name).toBe("New Admin");
    expect(upd.role).toBe("admin");
    expect("password_hash" in upd).toBe(false);
    // profiles.insert must NOT be called at all in live mode
    expect(insertCalls).toHaveLength(0);
  });

  it("forbids non-super-admin callers (403)", async () => {
    mockSession = { role: "admin", user_id: "a1" };
    const res = await POST(postJSON({ name: "X", email: "x@rc.pk", password: "secret123", role: "worker" }));
    expect(res.status).toBe(403);
  });

  it("validates the payload (422 on bad role)", async () => {
    const res = await POST(postJSON({ name: "X", email: "x@rc.pk", password: "secret123", role: "hacker" }));
    expect(res.status).toBe(422);
  });
});
