"use client";

import { ResourceManager } from "@/components/app/resource-manager";
import { UserStatusBadge } from "@/components/app/badges";
import { useSession } from "@/lib/use-session";
import type { Column } from "@/components/app/data-table";
import { formatCurrency } from "@/lib/utils";

interface WorkerRow {
  id: string;
  name: string;
  email: string;
  phone: string;
  worker_code: string | null;
  team_name: string | null;
  commission_rate: number;
  status: string;
  total_orders: number;
  delivered_orders: number;
  returned_orders: number;
  net_commission: number;
  paid_amount: number;
  remaining_amount: number;
}

export default function WorkersPage() {
  // Worker accounts are deleted ONLY by a super_admin (the API enforces it
  // and deletes the auth user) — hide the destructive control from plain
  // admins instead of letting them hit a 403.
  const { session } = useSession();
  const canDelete = session?.role === "super_admin";
  return (
    <ResourceManager<WorkerRow>
      title="Workers"
      description="Field team, commission rates and earnings at a glance"
      endpoint="/api/workers"
      canDelete={canDelete}
      searchPlaceholder="Search name, email, worker code…"
      searchFields={["name", "email", "worker_code", "phone"]}
      emptyTitle="No workers yet"
      emptyDescription="Create your first worker to start assigning orders."
      createLabel="Create worker"
      rowHref={(w) => `/admin/workers/${w.id}`}
      columns={[
        {
          key: "name",
          header: "Worker",
          render: (w) => (
            <div>
              <p className="font-medium">{w.name}</p>
              <p className="text-xs text-muted-foreground">{w.email}</p>
            </div>
          ),
        },
        { key: "worker_code", header: "ID", render: (w) => w.worker_code ?? "—", hideInCard: true },
        { key: "phone", header: "Phone", hideInCard: true },
        { key: "team_name", header: "Team", render: (w) => w.team_name ?? "—" },
        { key: "commission_rate", header: "Rate", render: (w) => `${w.commission_rate}%` },
        {
          key: "performance",
          header: "Orders",
          render: (w) => (
            <span className="text-xs">
              {w.total_orders} total · <span className="text-emerald-700">{w.delivered_orders} delivered</span> ·{" "}
              <span className="text-rose-600">{w.returned_orders} returned</span>
            </span>
          ),
        },
        {
          key: "remaining_amount",
          header: "Remaining",
          render: (w) => <span className="font-semibold">{formatCurrency(w.remaining_amount)}</span>,
        },
        { key: "status", header: "Status", render: (w) => <UserStatusBadge status={w.status} /> },
      ]}
      fields={[
        { name: "name", label: "Full name", type: "text", required: true },
        { name: "email", label: "Email", type: "email", required: true },
        { name: "phone", label: "Phone", type: "tel", required: true },
        { name: "password", label: "Password", type: "password", required: true, hint: "Used by the worker to sign in" },
        { name: "commission_rate", label: "Commission rate (%)", type: "number", required: true, min: 0, max: 100, step: "0.5", defaultValue: 5 },
      ]}
      transformSubmit={(v) => ({ ...v, commission_rate: Number(v.commission_rate) })}
      mapRowToForm={(w) => ({
        name: w.name,
        email: w.email,
        phone: w.phone,
        commission_rate: w.commission_rate,
        status: w.status,
      })}
    />
  );
}
