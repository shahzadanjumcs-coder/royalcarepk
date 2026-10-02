import { StockMovementForm } from "@/components/app/stock-movement-form";

export default function StockOutPage() {
  return (
    <StockMovementForm
      title="Stock Out"
      description="Remove stock for damage, loss or internal use — deducted from on-hand quantity"
      type="STOCK_OUT"
      quantityLabel="Quantity going out"
    />
  );
}
