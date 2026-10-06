"use client";

import { ResourceManager } from "@/components/app/resource-manager";
import { useSession } from "@/lib/use-session";
import type { Column } from "@/components/app/data-table";
import { formatCurrency } from "@/lib/utils";

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
  // DELETE /api/customers/[id] is admin-only — match the API gate so lower
  // roles never see a destructive control that would just 403.
  const { session } = useSession();
  const canDelete = session?.role === "super_admin" || session?.role === "admin";
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
      columns={[
        {
          key: "name",
          header: "Customer",
          render: (c) => (
            <div>
              <p className="font-medium">{c.name}</p>
              <p className="text-xs text-muted-foreground">{c.phone}</p>
            </div>
          ),
        },
        { key: "email", header: "Email", render: (c) => c.email ?? "—", hideInCard: true },
        { key: "city", header: "City", render: (c) => c.city ?? "—" },
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
