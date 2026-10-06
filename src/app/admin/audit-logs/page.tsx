"use client";

import { useState } from "react";
import { useList, buildQuery, usePagination, useDebounced } from "@/lib/client";
import { PageHeader } from "@/components/app/states";
import { DataTable, type Column } from "@/components/app/data-table";
import { SearchInput } from "@/components/app/filters";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/utils";
import type { AuditLog } from "@/lib/types";
import { ScrollText } from "lucide-react";

const ENTITIES = ["ALL", "auth", "profiles", "orders", "customers", "products", "inventory_movements", "worker_payments", "commission_transactions", "teams", "settings", "flaship"];

export default function AuditLogsPage() {
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search);
  const [entity, setEntity] = useState("ALL");
  const { page, setPage } = usePagination(20);
  const { data, loading, error, refresh } = useList<AuditLog>(
    `/api/audit-logs${buildQuery({ search: debounced, page, perPage: 20, f_entity: entity === "ALL" ? undefined : entity })}`,
    [debounced, entity, page]
  );

  const columns: Column<AuditLog>[] = [
    { key: "created_at", header: "When", render: (l) => <span className="whitespace-nowrap text-xs">{formatDateTime(l.created_at)}</span> },
    {
      key: "user_name",
      header: "User",
      render: (l) => (
        <div>
          <p className="font-medium">{l.user_name ?? "system"}</p>
          <p className="text-xs text-muted-foreground">{l.action}</p>
        </div>
      ),
    },
    { key: "entity", header: "Entity", render: (l) => <span className="rounded-md bg-muted px-2 py-0.5 text-xs">{l.entity}</span> },
    { key: "entity_id", header: "Record", render: (l) => <span className="font-mono text-[11px] text-muted-foreground">{l.entity_id ? `${l.entity_id.slice(0, 8)}…` : "—"}</span>, hideInCard: true },
    {
      key: "new_data",
      header: "Changes",
      render: (l) => {
        const payload = l.new_data ?? l.old_data;
        if (!payload) return <span className="text-muted-foreground">—</span>;
        return <span className="line-clamp-2 max-w-xs text-xs text-muted-foreground">{JSON.stringify(payload).slice(0, 120)}</span>;
      },
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Audit Logs" description="Every important action, with actor, entity and data snapshots" />

      <DataTable
        columns={columns}
        rows={data?.rows}
        loading={loading}
        error={error}
        onRetry={refresh}
        emptyTitle="No audit entries"
        emptyIcon={ScrollText}
        page={page}
        perPage={20}
        total={data?.total ?? 0}
        onPageChange={setPage}
        toolbar={
          <div className="space-y-2">
            <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search action or user…" className="lg:w-80" />
            <div className="flex flex-wrap gap-1.5">
              {ENTITIES.map((e) => (
                <Button
                  key={e}
                  size="sm"
                  variant={entity === e ? "default" : "outline"}
                  className="h-7 rounded-full px-2.5 text-[11px]"
                  onClick={() => { setEntity(e); setPage(1); }}
                >
                  {e === "ALL" ? "All" : e.replace(/_/g, " ")}
                </Button>
              ))}
            </div>
          </div>
        }
      />
    </div>
  );
}
