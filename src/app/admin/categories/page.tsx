"use client";

import { ResourceManager } from "@/components/app/resource-manager";
import type { Column } from "@/components/app/data-table";

interface CategoryRow {
  id: string;
  name: string;
  description: string | null;
  product_count: number;
  status: string;
}

export default function CategoriesPage() {
  return (
    <ResourceManager<CategoryRow>
      title="Categories"
      description="Organize your product catalog"
      endpoint="/api/categories"
      emptyTitle="No categories yet"
      emptyDescription="Categories help you group products in reports."
      createLabel="Add category"
      columns={[
        { key: "name", header: "Category", render: (c) => <span className="font-medium">{c.name}</span> },
        { key: "description", header: "Description", render: (c) => c.description ?? "—", hideInCard: true },
        { key: "product_count", header: "Products" },
        { key: "status", header: "Status", render: (c) => <span className="capitalize text-xs">{c.status}</span>, hideInCard: true },
      ]}
      fields={[
        { name: "name", label: "Category name", type: "text", required: true },
        { name: "description", label: "Description", type: "textarea" },
      ]}
    />
  );
}
