import { StockMovementForm } from "@/components/app/stock-movement-form";

export default function StockInPage() {
  return (
    <StockMovementForm
      title="Stock In"
      description="Record purchased or replenished stock"
      type="STOCK_IN"
      quantityLabel="Quantity received"
    />
  );
}
