import { FlashipCatalog } from "@/components/app/flaship-catalog";

export default function PickupsPage() {
  return (
    <FlashipCatalog
      type="pickups"
      title="Pickup Locations"
      description="Warehouses and dispatch points registered with Flaship"
      columns={[
        { key: "name", label: "Location" },
        { key: "address", label: "Address" },
        { key: "city", label: "City" },
        { key: "contact", label: "Contact" },
        { key: "active", label: "Status" },
        { key: "synced_at", label: "Last synced" },
      ]}
    />
  );
}
