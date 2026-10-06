"use client";

import { ResourceManager } from "@/components/app/resource-manager";
import { useSession } from "@/lib/use-session";
import type { Column } from "@/components/app/data-table";

interface SupplierRow {
  id: string;
  name: string;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  product_count: number;
  status: string;
}

export default function SuppliersPage() {
  const { session } = useSession();
  // DELETE here is admin-only — hide the destructive control from inventory_manager.
  const canDelete = session?.role === "super_admin" || session?.role === "admin";
  return (
    <ResourceManager<SupplierRow>
      canDelete={canDelete}
      title="Suppliers"
      description="Vendors you purchase stock from"
      endpoint="/api/suppliers"
      emptyTitle="No suppliers yet"
      emptyDescription="Add suppliers to link products to their source."
      createLabel="Add supplier"
      columns={[
        {
          key: "name",
          header: "Supplier",
          render: (s) => (
            <div>
              <p className="font-medium">{s.name}</p>
              <p className="text-xs text-muted-foreground">{s.contact_person ?? "—"}</p>
            </div>
          ),
        },
        { key: "phone", header: "Phone", render: (s) => s.phone ?? "—" },
        { key: "email", header: "Email", render: (s) => s.email ?? "—", hideInCard: true },
        { key: "product_count", header: "Products" },
        { key: "status", header: "Status", render: (s) => <span className="capitalize text-xs">{s.status}</span>, hideInCard: true },
      ]}
      fields={[
        { name: "name", label: "Supplier name", type: "text", required: true },
        { name: "contact_person", label: "Contact person", type: "text" },
        { name: "phone", label: "Phone", type: "tel" },
        { name: "email", label: "Email", type: "email" },
        { name: "address", label: "Address", type: "textarea" },
      ]}
    />
  );
}
