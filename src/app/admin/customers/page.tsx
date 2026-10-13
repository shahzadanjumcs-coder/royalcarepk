"use client";

import { ResourceManager } from "@/components/app/resource-manager";
import { useSession } from "@/lib/use-session";
import { api, ApiError } from "@/lib/client";
import { Badge } from "@/components/ui/badge";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { Column } from "@/components/app/data-table";
import { formatCurrency } from "@/lib/utils";
import { Archive, ArchiveRestore } from "lucide-react";

interface CustomerRow {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  city: string | null;
  status: string;
  total_orders: number;
  delivered_orders: number;
  returned_orders: number;
  total_spending: number;
}

export default function CustomersPage() {
  // DELETE /api/customers/[id] and the status toggle are admin-only — match
  // the API gate so lower roles never see a destructive control that would
  // just 403.
  const { session } = useSession();
  const isAdmin = session?.role === "super_admin" || session?.role === "admin";

  const toggleStatus = async (row: CustomerRow): Promise<string> => {
    const next = row.status === "active" ? "disabled" : "active";
    try {
      await api(`/api/customers/${row.id}`, { method: "PATCH", json: { status: next } });
      return next === "disabled"
        ? `${row.name} disabled — hidden from order forms, order history preserved.`
        : `${row.name} restored to active.`;
    } catch (e) {
      throw new Error(e instanceof ApiError ? e.message : "Could not update the customer.");
    }
  };

  const removeCustomer = async (row: CustomerRow): Promise<string> => {
    try {
      const res = await api<{ message?: string }>(`/api/customers/${row.id}`, { method: "DELETE" });
      // The API reports when it archived instead of deleted — surface it so the
      // row visibly staying in the list is never mistaken for a broken button.
      return res?.message || `${row.name} deleted.`;
    } catch (e) {
      throw new Error(e instanceof ApiError ? e.message : "Could not delete the customer.");
    }
  };

  const statusColumn: Column<CustomerRow> = {
    key: "status",
    header: "Status",
    render: (c) =>
      c.status === "active" ? (
        <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">Active</Badge>
      ) : (
        <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">Disabled</Badge>
      ),
  };

  return (
    <ResourceManager<CustomerRow>
      title="Customers"
      description="Contact book with order history and spending"
      endpoint="/api/customers"
      searchPlaceholder="Search name, phone, email, city…"
      searchFields={["name", "phone", "email", "city"]}
      emptyTitle="No customers yet"
      emptyDescription="Customers are auto-created with orders, or add them here first."
      createLabel="Add customer"
      rowHref={(c) => `/admin/customers/${c.id}`}
      canCreate={isAdmin}
      canEdit={isAdmin}
      canDelete={isAdmin}
      onDelete={removeCustomer}
      deleteTitle={(c) => `Remove ${c.name}?`}
      deleteDescription={(c) =>
        c.total_orders > 0
          ? `${c.name} has ${c.total_orders} order(s). The customer will be DISABLED (archived), not deleted — all order, payment and commission history stays intact. You can restore them anytime from this list.`
          : `${c.name} has no order history and will be PERMANENTLY deleted. This cannot be undone.`
      }
      extraActions={(row) =>
        isAdmin ? (
          row.status === "active" ? (
            <DropdownMenuItem key="disable" onClick={() => void toggleStatus(row)}>
              <Archive className="mr-2 h-3.5 w-3.5" /> Disable (archive)
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem key="restore" onClick={() => void toggleStatus(row)}>
              <ArchiveRestore className="mr-2 h-3.5 w-3.5" /> Restore to active
            </DropdownMenuItem>
          )
        ) : null
      }
      columns={[
        {
          key: "name",
          header: "Customer",
          render: (c) => (
            <div>
              <p className={`font-medium ${c.status !== "active" ? "text-muted-foreground" : ""}`}>{c.name}</p>
              <p className="text-xs text-muted-foreground">{c.phone}</p>
            </div>
          ),
        },
        { key: "email", header: "Email", render: (c) => c.email ?? "—", hideInCard: true },
        { key: "city", header: "City", render: (c) => c.city ?? "—" },
        statusColumn,
        { key: "total_orders", header: "Orders" },
        { key: "delivered_orders", header: "Delivered", hideInCard: true },
        { key: "returned_orders", header: "Returned", hideInCard: true },
        { key: "total_spending", header: "Spending", render: (c) => formatCurrency(c.total_spending) },
      ]}
      fields={[
        { name: "name", label: "Name", type: "text", required: true },
        { name: "phone", label: "Phone", type: "tel", required: true },
        { name: "email", label: "Email", type: "email" },
        { name: "city", label: "City", type: "text" },
        { name: "address", label: "Address", type: "textarea" },
        { name: "notes", label: "Notes", type: "textarea", placeholder: "Optional" },
      ]}
    />
  );
}
