"use client";

import Link from "next/link";
import { useApi } from "@/lib/client";
import { PageHeader, ErrorState, PageSpinner } from "@/components/app/states";
import { StatCard } from "@/components/app/stat-card";
import { OrderStatusBadge } from "@/components/app/badges";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatNumber, timeAgo } from "@/lib/utils";
import type { WorkerDetail } from "@/lib/services/workers";
import { CalendarClock, CheckCircle2, Clock, PackageCheck, PercentCircle, RotateCcw, ShoppingCart, Wallet } from "lucide-react";

export default function WorkerDashboardPage() {
  const { data, loading, error, refresh } = useApi<{ worker: WorkerDetail }>("/api/worker/summary");

  if (loading) return <PageSpinner />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;
  if (!data) return null;
  const { worker: w } = data;
  const e = w.earnings;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title={`Salam, ${w.name.split(" ")[0]} 👋`}
        description={`${w.worker_code ?? ""} · ${w.team_name ?? "No team"} · commission rate ${w.commission_rate}%`}
      />

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Your orders">
        <StatCard label="Today's Orders" value={formatNumber(w.performance.today_orders ?? 0)} icon={CalendarClock} tint="teal" loading={loading} />
        <StatCard label="Total Orders" value={formatNumber(w.performance.total_orders)} icon={ShoppingCart} tint="slate" loading={loading} />
        <StatCard label="Delivered" value={formatNumber(w.performance.delivered)} icon={PackageCheck} tint="emerald" loading={loading} />
        <StatCard label="Returned" value={formatNumber(w.performance.returned)} icon={RotateCcw} tint="rose" loading={loading} />
      </section>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Your earnings">
        <StatCard label="In progress" value={formatNumber(w.performance.in_progress)} icon={Clock} tint="amber" loading={loading} />
        <StatCard label="Total COD" value={formatCurrency(w.performance.total_cod)} icon={Wallet} tint="emerald" loading={loading} />
        <StatCard label="Earned Commission" value={formatCurrency(e.delivered_commission)} icon={PercentCircle} tint="emerald" loading={loading} />
        <StatCard label="Return Adjustments" value={formatCurrency(e.return_adjustment)} icon={RotateCcw} tint="rose" loading={loading} />
      </section>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3" aria-label="Net position">
        <StatCard label="Net Commission" value={formatCurrency(e.net_commission)} icon={PercentCircle} tint="emerald" hint="Earned − adjustments" loading={loading} />
        <StatCard label="Paid" value={formatCurrency(e.paid_amount)} icon={CheckCircle2} tint="teal" loading={loading} />
        <StatCard label="Remaining" value={formatCurrency(e.remaining_amount)} icon={Wallet} tint="amber" loading={loading} />
      </section>

      <section className="rounded-xl border border-border bg-card" aria-label="Recent orders">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold">Recent assigned orders</h3>
          <Button asChild variant="ghost" size="sm" className="text-xs text-emerald-700">
            <Link href="/worker/orders">View all</Link>
          </Button>
        </div>
        {w.recent_orders.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">No orders assigned yet — check back soon.</p>
        ) : (
          <div className="divide-y divide-border/70">
            {w.recent_orders.slice(0, 5).map((o) => (
              <Link key={o.id} href={`/worker/orders/${o.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted/40">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{o.order_number}</p>
                  <p className="truncate text-xs text-muted-foreground">{o.customer_name} · {timeAgo(o.created_at)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-sm font-semibold">{formatCurrency(o.total)}</span>
                  <OrderStatusBadge status={o.status} />
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
