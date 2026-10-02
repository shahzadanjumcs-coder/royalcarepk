"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useApi, api } from "@/lib/client";
import { PageHeader, PageSpinner, ErrorState } from "@/components/app/states";
import { UserStatusBadge } from "@/components/app/badges";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime } from "@/lib/utils";
import { LogOut } from "lucide-react";

export default function WorkerProfilePage() {
  const router = useRouter();
  const { data, loading, error, refresh } = useApi<{
    worker: {
      name: string;
      email: string;
      phone: string;
      worker_code: string | null;
      team_name: string | null;
      role: string;
      status: string;
      commission_rate: number;
      created_at: string;
      performance: { total_orders: number; delivered: number; returned: number; success_rate: string };
    };
  }>("/api/worker/summary");

  useEffect(() => {
    // keep session fresh on visit
    void fetch("/api/auth/session").catch(() => undefined);
  }, []);

  if (loading) return <PageSpinner />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;
  if (!data) return null;
  const w = data.worker;

  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  };

  const row = (label: string, value: string) => (
    <div className="flex items-center justify-between border-b border-border/60 py-2.5 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title="My Profile" />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-base">
            <span>{w.name}</span>
            <UserStatusBadge status={w.status} />
          </CardTitle>
        </CardHeader>
        <CardContent>
          {row("Email", w.email)}
          {row("Phone", w.phone || "—")}
          {row("Worker ID", w.worker_code ?? "—")}
          {row("Team", w.team_name ?? "—")}
          {row("Commission rate", `${w.commission_rate}%`)}
          {row("Member since", formatDateTime(w.created_at))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Performance</CardTitle></CardHeader>
        <CardContent>
          {row("Total orders", String(w.performance.total_orders))}
          {row("Delivered", String(w.performance.delivered))}
          {row("Returned", String(w.performance.returned))}
          {row("Success rate", w.performance.success_rate)}
        </CardContent>
      </Card>

      <Button variant="outline" className="w-full border-rose-200 text-rose-700 hover:bg-rose-50" onClick={() => void logout()}>
        <LogOut className="mr-2 h-4 w-4" /> Sign out
      </Button>
    </div>
  );
}
