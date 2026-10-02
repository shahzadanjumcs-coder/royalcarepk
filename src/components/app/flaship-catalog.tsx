"use client";

import { useState } from "react";
import { api, useApi } from "@/lib/client";
import { PageHeader } from "./states";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, RefreshCw } from "lucide-react";
import { formatDateTime } from "@/lib/utils";

interface CatalogProps {
  type: "couriers" | "cities" | "pickups";
  title: string;
  description: string;
  columns: { key: string; label: string }[];
}

export function FlashipCatalog({ type, title, description, columns }: CatalogProps) {
  const { data, loading, error, refresh } = useApi<{ rows: Record<string, unknown>[]; mode?: string }>(`/api/flaship/catalog?type=${type}`);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const sync = async () => {
    setSyncing(true);
    setMessage(null);
    try {
      const res = await api<{ count: number }>("/api/flaship/catalog", { method: "POST", json: { type } });
      setMessage(`Synced ${res.count} ${type} from Flaship.`);
      refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Sync failed.");
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title={title}
        description={description}
        actions={
          <Button onClick={sync} disabled={syncing}>
            {syncing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}
            Sync from Flaship
          </Button>
        }
      />

      {message ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{message}</div>
      ) : null}
      {error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/60">
                {columns.map((c) => (
                  <th key={c.key} className="px-4 py-2.5 text-left font-semibold">{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={columns.length} className="px-4 py-10 text-center text-muted-foreground">Loading…</td></tr>
              ) : !data || data.rows.length === 0 ? (
                <tr><td colSpan={columns.length} className="px-4 py-10 text-center text-muted-foreground">No entries yet — press Sync.</td></tr>
              ) : (
                data.rows.map((row, i) => (
                  <tr key={(row.id as string) ?? i} className="border-t border-border/60 hover:bg-muted/30">
                    {columns.map((c) => (
                      <td key={c.key} className="px-4 py-2.5">
                        {c.key === "synced_at"
                          ? (row[c.key] ? formatDateTime(row[c.key] as string) : "—")
                          : c.key === "active"
                            ? <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">Active</Badge>
                            : String(row[c.key] ?? "—")}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
