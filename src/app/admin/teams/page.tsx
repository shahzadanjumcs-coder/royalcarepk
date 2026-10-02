"use client";

import { ResourceManager } from "@/components/app/resource-manager";
import type { Column } from "@/components/app/data-table";

interface TeamRow {
  id: string;
  name: string;
  description: string | null;
  leader_name: string | null;
  member_count: number;
  status: string;
}

export default function TeamsPage() {
  return (
    <ResourceManager<TeamRow>
      title="Teams"
      description="Group workers into zones or shifts"
      endpoint="/api/teams"
      emptyTitle="No teams yet"
      emptyDescription="Create teams to organize workers by area or shift."
      createLabel="Create team"
      columns={[
        { key: "name", header: "Team", render: (t) => <span className="font-medium">{t.name}</span> },
        { key: "description", header: "Description", render: (t) => t.description ?? "—", hideInCard: true },
        { key: "leader_name", header: "Lead", render: (t) => t.leader_name ?? "—", hideInCard: true },
        { key: "member_count", header: "Members" },
        { key: "status", header: "Status", render: (t) => <span className="capitalize">{t.status}</span> },
      ]}
      fields={[
        { name: "name", label: "Team name", type: "text", required: true, placeholder: "Karachi Central" },
        { name: "description", label: "Description", type: "textarea", placeholder: "Optional" },
      ]}
    />
  );
}
