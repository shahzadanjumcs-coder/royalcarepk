import { store } from "@/lib/store";
import type { ListOptions, TableName } from "@/lib/store/base";

/** Resolve display names for a set of rows via FK lookups (works in both modes). */
export async function withRefs<T extends { id: string }>(
  rows: T[],
  refs: { table: TableName; as: string; field: string; fields: string[] }[]
): Promise<T[]> {
  if (!rows.length) return rows;
  const caches = new Map<string, Map<string, Record<string, unknown>>>();
  for (const ref of refs) {
    const { rows: all } = await store.list(ref.table);
    const map = new Map<string, Record<string, unknown>>();
    for (const r of all) map.set(r.id as string, r);
    caches.set(ref.as, map);
    void ref;
  }
  return rows.map((row) => {
    const out = { ...row } as Record<string, unknown>;
    for (const ref of refs) {
      const fk = row[ref.field as keyof T] as string | null | undefined;
      const cache = caches.get(ref.as)!;
      const target = fk ? cache.get(fk) : undefined;
      out[ref.as] = target
        ? Object.fromEntries(ref.fields.map((f) => [f, target[f] ?? null]))
        : null;
    }
    return out as T;
  });
}

export function listOptsFrom(url: URL, searchFields: string[], dateField = "created_at"): ListOptions {
  const sp = url.searchParams;
  const opts: ListOptions = { filters: {} };
  const q = sp.get("search");
  if (q) opts.search = { q, fields: searchFields };
  const from = sp.get("from");
  const to = sp.get("to");
  if (from || to) opts.dateRange = { field: dateField, from, to };
  sp.forEach((v, k) => {
    if (k.startsWith("f_") && v) opts.filters![k.slice(2)] = v;
  });
  return opts;
}
