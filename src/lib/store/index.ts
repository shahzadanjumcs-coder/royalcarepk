import type { ListOptions, Store, TableName } from "./base";
import { memoryStore } from "./memory";
import { SupabaseStore } from "./supabase";
import { getServiceRoleClient } from "@/lib/supabase/server";

/** True when the app runs without Supabase credentials (embedded demo store). */
export const IS_DEMO_MODE =
  !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let supabaseStoreInstance: SupabaseStore | null = null;

/**
 * The active store. In demo mode this is the embedded JSON-persisted store;
 * in live mode it talks to Supabase Postgres via the service-role client.
 */
export async function getStore(): Promise<Store> {
  if (IS_DEMO_MODE) return memoryStore;
  if (!supabaseStoreInstance) {
    // The data layer is server-side trusted and request-independent, so it MUST use
    // the service-role client (never a cookie-scoped client). Authorization is
    // enforced by withAuth + the service layer; RLS stays as defense-in-depth.
    // A cookie-scoped client would silently run queries as anon (or as whatever
    // user happened to create this singleton first) — that bug is why staff lists
    // returned empty rows and branding fell back to defaults in live mode.
    const client = getServiceRoleClient();
    if (!client) {
      throw new Error("Supabase URL/anon key are set but SUPABASE_SERVICE_ROLE_KEY is missing — refusing to run the data layer with degraded privileges.");
    }
    supabaseStoreInstance = new SupabaseStore(client);
  }
  return supabaseStoreInstance;
}

/** Synchronous store handle — resolves the underlying adapter lazily per call. */
export const store: Store = {
  async list<T = Record<string, unknown>>(table: TableName, opts?: ListOptions) {
    return (await getStore()).list<T>(table, opts);
  },
  async get<T = Record<string, unknown>>(table: TableName, id: string) {
    return (await getStore()).get<T>(table, id);
  },
  async first<T = Record<string, unknown>>(table: TableName, filters: Record<string, unknown>) {
    return (await getStore()).first<T>(table, filters);
  },
  async insert<T = Record<string, unknown>>(table: TableName, data: Record<string, unknown>) {
    return (await getStore()).insert<T>(table, data);
  },
  async insertMany(table, rows) {
    return (await getStore()).insertMany(table, rows);
  },
  async upsertMany(table, rows, conflictKeys) {
    return (await getStore()).upsertMany(table, rows, conflictKeys);
  },
  async update<T = Record<string, unknown>>(table: TableName, id: string, data: Record<string, unknown>) {
    return (await getStore()).update<T>(table, id, data);
  },
  async delete(table, id) {
    return (await getStore()).delete(table, id);
  },
  async count(table, filters) {
    return (await getStore()).count(table, filters);
  },
};

export { memoryStore } from "./memory";
