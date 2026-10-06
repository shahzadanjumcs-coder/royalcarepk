"use client";

import { useState } from "react";
import { ResourceManager } from "@/components/app/resource-manager";
import { FormDialog } from "@/components/app/form-dialog";
import { useApi, api } from "@/lib/client";
import type { Column } from "@/components/app/data-table";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";
import { Plus } from "lucide-react";

interface AssignmentRow {
  id: string;
  user_name: string;
  worker_code: string | null;
  team_name: string;
  role_in_team: string;
  joined_at: string;
}

export default function AssignmentsPage() {
  const [open, setOpen] = useState(false);
  const { data: workers } = useApi<{ rows: { id: string; name: string; worker_code: string | null }[] }>("/api/users?perPage=100");
  const { data: teams, refresh: refreshTeams } = useApi<{ rows: { id: string; name: string }[] }>("/api/teams");

  return (
    <div>
      <ResourceManager<AssignmentRow>
        title="Assignments"
        description="Which workers belong to which teams"
        endpoint="/api/assignments"
        emptyTitle="No assignments yet"
        emptyDescription="Assign workers to teams to organize your field force."
        createLabel="Assign worker"
        canDelete
        canEdit={false}
        canCreate={false}
        columns={[
          { key: "user_name", header: "Worker", render: (a) => (
            <div>
              <p className="font-medium">{a.user_name}</p>
              <p className="text-xs text-muted-foreground">{a.worker_code ?? "—"}</p>
            </div>
          ) },
          { key: "team_name", header: "Team" },
          { key: "role_in_team", header: "Role in team" },
          { key: "joined_at", header: "Joined", render: (a) => formatDate(a.joined_at), hideInCard: true },
        ]}
        fields={[]}
        toolbar={
          <Button onClick={() => setOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> New assignment
          </Button>
        }
      />

      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title="Assign worker to team"
        fields={[
          {
            name: "user_id",
            label: "Worker",
            type: "select",
            required: true,
            options: (workers?.rows ?? []).map((w) => ({ value: w.id, label: `${w.name} (${w.worker_code ?? "staff"})` })),
          },
          {
            name: "team_id",
            label: "Team",
            type: "select",
            required: true,
            options: (teams?.rows ?? []).map((t) => ({ value: t.id, label: t.name })),
          },
          { name: "role_in_team", label: "Role in team", type: "text", defaultValue: "Rider", placeholder: "Rider / Senior Rider" },
        ]}
        submitLabel="Assign"
        onSubmit={async (values) => {
          await api("/api/assignments", { method: "POST", json: values });
          refreshTeams();
        }}
      />
    </div>
  );
}
