"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useApi } from "@/lib/client";
import { PageHeader, ErrorState, PageSpinner } from "@/components/app/states";
import { StatCard } from "@/components/app/stat-card";
import { RangeFilter } from "@/components/app/filters";
import { OrderStatusBadge } from "@/components/app/badges";
import {
  OrdersAreaChart,
  DeliveredReturnedChart,
  SalesBarChart,
  StatusPieChart,
  WorkerPerformanceChart,
  InventoryMovementChart,
} from "@/components/charts/charts";
import type { DashboardData } from "@/lib/services/dashboard";
import { formatCurrency, formatNumber } from "@/lib/utils";
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  Clock,
  PackageCheck,
  PercentCircle,
  RotateCcw,
  ShoppingCart,
  Truck,
  Wallet,
  XCircle,
  CalendarClock,
  Banknote,
} from "lucide-react";

export default function AdminDashboardPage() {
  const [preset, setPreset] = useState("30d");
  const { data, loading, error, refresh } = useApi<DashboardData & { range: { from: string; to: string } }>(
    `/api/dashboard?preset=${preset}`,
    [preset]
  );

  const chartData = useMemo(() => (data?.series ?? []).slice(-30), [data]);

  if (loading && !data) return <PageSpinner />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;
  if (!data) return null;

  const s = data.stats;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Dashboard"
        description={`Business overview · ${data.range.from} → ${data.range.to}`}
        actions={<RangeFilter value={{ preset }} onChange={(v) => setPreset(v.preset)} />}
      />

      {data.failedBookings > 0 ? (
        <Link href="/admin/flaship/booking" className="block rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 no-print transition-colors hover:bg-rose-100/70">
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 shrink-0 text-rose-600" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-rose-800">
                {data.failedBookings} Flaship booking{data.failedBookings > 1 ? "s" : ""} failed
              </p>
              <p className="truncate text-xs text-rose-600">Open the booking console to review errors and retry.</p>
            </div>
          </div>
        </Link>
      ) : null}

      {/* Order stats */}
      <section aria-label="Order statistics">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
          <StatCard label="Total Orders" value={formatNumber(s.totalOrders)} icon={ShoppingCart} tint="slate" loading={loading} />
          <StatCard label="Today's Orders" value={formatNumber(s.todayOrders)} icon={CalendarClock} tint="teal" loading={loading} />
          <StatCard label="Pending" value={formatNumber(s.pendingOrders)} icon={Clock} tint="amber" hint="Created · Pending · Assigned" loading={loading} />
          <StatCard label="In Transit" value={formatNumber(s.inTransit)} icon={Truck} tint="violet" loading={loading} />
          <StatCard label="Delivered" value={formatNumber(s.delivered)} icon={PackageCheck} tint="emerald" loading={loading} />
          <StatCard label="Returned" value={formatNumber(s.returned)} icon={RotateCcw} tint="rose" loading={loading} />
          <StatCard label="Cancelled" value={formatNumber(s.cancelled)} icon={XCircle} tint="slate" loading={loading} />
          <StatCard label="Total Sales" value={formatCurrency(s.totalSales)} icon={Banknote} tint="emerald" hint="Delivered COD value" loading={loading} />
        </div>
      </section>

      {/* Money + stock stats */}
      <section aria-label="Finance and inventory statistics">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <StatCard label="Total COD" value={formatCurrency(s.totalCOD)} icon={Wallet} tint="emerald" loading={loading} />
          <StatCard label="Stock Value" value={formatCurrency(s.stockValue)} icon={Boxes} tint="sky" hint="At purchase price" loading={loading} />
          <StatCard label="Low Stock" value={formatNumber(s.lowStockProducts)} icon={AlertTriangle} tint="amber" hint="At/below minimum" loading={loading} />
          <StatCard label="Commission (gross)" value={formatCurrency(s.totalCommission)} icon={PercentCircle} tint="teal" loading={loading} />
          <StatCard label="Commission Paid" value={formatCurrency(s.paidCommission)} icon={CheckCircle2} tint="emerald" loading={loading} />
          <StatCard label="Payments Due" value={formatCurrency(s.pendingPayments)} icon={Wallet} tint="rose" hint="Net − paid" loading={loading} />
        </div>
      </section>

      {/* Charts */}
      <section className="grid gap-4 xl:grid-cols-2" aria-label="Charts">
        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="text-sm font-semibold">Orders over time</h3>
          <p className="mb-2 text-xs text-muted-foreground">Daily created orders in range</p>
          <OrdersAreaChart data={chartData} />
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="text-sm font-semibold">Delivered vs Returned</h3>
          <p className="mb-2 text-xs text-muted-foreground">Daily outcomes in range</p>
          <DeliveredReturnedChart data={chartData} />
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="text-sm font-semibold">Sales</h3>
          <p className="mb-2 text-xs text-muted-foreground">Daily delivered COD value</p>
          <SalesBarChart data={chartData} />
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="text-sm font-semibold">Order status mix</h3>
          <p className="mb-2 text-xs text-muted-foreground">All-time distribution</p>
          <StatusPieChart data={data.statusDistribution} />
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="text-sm font-semibold">Worker performance</h3>
          <p className="mb-2 text-xs text-muted-foreground">Delivered vs returned per worker (in range)</p>
          <WorkerPerformanceChart data={data.workerPerformance} />
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="text-sm font-semibold">Inventory movement</h3>
          <p className="mb-2 text-xs text-muted-foreground">Units in vs out — last 14 days</p>
          <InventoryMovementChart data={data.inventoryMovement} />
        </div>
      </section>

      {/* Bottom: recent orders + low stock */}
      <section className="grid gap-4 xl:grid-cols-2" aria-label="Recent activity">
        <div className="rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold">Recent orders</h3>
            <Link href="/admin/orders" className="text-xs font-medium text-emerald-700 hover:underline">
              View all
            </Link>
          </div>
          <div className="divide-y divide-border/70">
            {data.recentOrders.map((o) => (
              <Link key={o.id} href={`/admin/orders/${o.id}`} className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-muted/40">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{o.order_number}</p>
                  <p className="truncate text-xs text-muted-foreground">{o.customer_name}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-sm font-semibold">{formatCurrency(o.total)}</span>
                  <OrderStatusBadge status={o.status} />
                </div>
              </Link>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold">Low stock products</h3>
            <Link href="/admin/inventory" className="text-xs font-medium text-emerald-700 hover:underline">
              Manage stock
            </Link>
          </div>
          {data.lowStock.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">All products are above minimum stock. 🎉</p>
          ) : (
            <div className="divide-y divide-border/70">
              {data.lowStock.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{p.name}</p>
                    <p className="text-xs text-muted-foreground">{p.sku}</p>
                  </div>
                  <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700">
                    {p.available} left · min {p.min_stock}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
