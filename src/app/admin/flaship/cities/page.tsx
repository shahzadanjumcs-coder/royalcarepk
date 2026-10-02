import { FlashipCatalog } from "@/components/app/flaship-catalog";

export default function CitiesPage() {
  return (
    <FlashipCatalog
      type="cities"
      title="Cities"
      description="Serviceable destinations from the Flaship network"
      columns={[
        { key: "name", label: "City" },
        { key: "province", label: "Province" },
        { key: "city_id", label: "City ID" },
        { key: "active", label: "Status" },
        { key: "synced_at", label: "Last synced" },
      ]}
    />
  );
}
