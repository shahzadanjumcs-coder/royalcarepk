// ============================================================
// Unified store abstraction — one API, two adapters:
//  - supabase: real Supabase Postgres (production)
//  - memory:   embedded demo store with JSON persistence (sandbox/preview)
// ============================================================

export type TableName =
  | "profiles"
  | "teams"
  | "team_members"
  | "customers"
  | "categories"
  | "suppliers"
  | "products"
  | "orders"
  | "order_items"
  | "order_status_history"
  | "shipments"
  | "shipment_tracking"
  | "commission_transactions"
  | "commission_rules"
  | "worker_payments"
  | "flaship_couriers"
  | "flaship_cities"
  | "flaship_pickups"
  | "flaship_logs"
  | "inventory_movements"
  | "notifications"
  | "audit_logs"
  | "settings"
  | "whatsapp_accounts"
  | "whatsapp_routing_settings"
  | "whatsapp_admin_recipients"
  | "whatsapp_group_settings"
  | "whatsapp_bot_settings"
  | "whatsapp_message_queue"
  | "whatsapp_message_logs"
  | "whatsapp_commands";

export interface ListOptions {
  filters?: Record<string, unknown>;
  inFilters?: Record<string, unknown[]>;
  /** column names that must be NULL (e.g. tracking_number for unbooked orders) */
  nullFilters?: string[];
  search?: { q: string; fields: string[] };
  dateRange?: { field: string; from?: string | null; to?: string | null };
  orderBy?: { field: string; dir: "asc" | "desc" };
  page?: number;
  perPage?: number;
}

export interface ListResult<T> {
  rows: T[];
  total: number;
}

export type WithId<T> = T & { id: string };

export interface Store {
  list<T = Record<string, unknown>>(table: TableName, opts?: ListOptions): Promise<ListResult<WithId<T>>>;
  get<T = Record<string, unknown>>(table: TableName, id: string): Promise<WithId<T> | null>;
  first<T = Record<string, unknown>>(table: TableName, filters: Record<string, unknown>): Promise<WithId<T> | null>;
  insert<T = Record<string, unknown>>(table: TableName, data: Record<string, unknown>): Promise<WithId<T>>;
  insertMany(table: TableName, rows: Record<string, unknown>[]): Promise<void>;
  /** Bulk upsert keyed on existing UNIQUE column(s): insert missing rows, merge the rest. */
  upsertMany(table: TableName, rows: Record<string, unknown>[], conflictKeys: string[]): Promise<void>;
  update<T = Record<string, unknown>>(table: TableName, id: string, data: Record<string, unknown>): Promise<WithId<T>>;
  delete(table: TableName, id: string): Promise<void>;
  count(table: TableName, filters?: Record<string, unknown>): Promise<number>;
}

export function nextDayISO(dateISO: string): string {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
