import { StockMovementForm } from "@/components/app/stock-movement-form";

export default function InventoryReturnsPage() {
  return (
    <StockMovementForm
      title="Return Received"
      description="Add returned parcels back into available stock once physically received"
      type="RETURN"
      quantityLabel="Quantity received back"
    />
  );
}
