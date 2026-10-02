import { FlashipCatalog } from "@/components/app/flaship-catalog";

export default function CouriersPage() {
  return (
    <FlashipCatalog
      type="couriers"
      title="Couriers"
      description="Courier partners available for booking, loaded from the Flaship catalog"
      columns={[
        { key: "name", label: "Courier" },
        { key: "courier_id", label: "Courier ID" },
        { key: "active", label: "Status" },
        { key: "synced_at", label: "Last synced" },
      ]}
    />
  );
}
