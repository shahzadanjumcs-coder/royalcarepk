"use client";

import Link from "next/link";
import { useApi, api } from "@/lib/client";
import { PageHeader } from "@/components/app/states";
import { Button } from "@/components/ui/button";
import { cn, timeAgo } from "@/lib/utils";
import { Bell, CheckCheck, Info, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";

interface NotificationItem {
  id: string;
  user_id: string | null;
  title: string;
  message: string;
  type: string;
  link: string | null;
  read: boolean;
  created_at: string;
}

const TYPE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};

const TYPE_STYLE: Record<string, string> = {
  info: "bg-sky-100 text-sky-700",
  success: "bg-emerald-100 text-emerald-700",
  warning: "bg-amber-100 text-amber-700",
  error: "bg-rose-100 text-rose-700",
};

export default function NotificationsPage() {
  const { data, loading, error, refresh } = useApi<{ rows: NotificationItem[]; unread: number }>("/api/notifications?limit=50");

  const markAll = async () => {
    await api("/api/notifications", { method: "POST", json: { all: true } });
    refresh();
  };

  const markOne = async (id: string) => {
    await api("/api/notifications", { method: "POST", json: { id } });
    refresh();
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title="Notifications"
        description={data ? `${data.unread} unread of ${data.rows.length}` : "Business alerts feed"}
        actions={
          <Button variant="outline" onClick={markAll} disabled={!data?.unread}>
            <CheckCheck className="mr-1.5 h-4 w-4" /> Mark all read
          </Button>
        }
      />

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {loading ? (
          <p className="px-4 py-12 text-center text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="px-4 py-12 text-center text-sm text-rose-600">{error}</p>
        ) : !data || data.rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-14 text-center">
            <Bell className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No notifications yet.</p>
          </div>
        ) : (
          <div className="divide-y divide-border/70">
            {data.rows.map((n) => {
              const Icon = TYPE_ICON[n.type] ?? Info;
              const body = (
                <div className={cn("flex gap-3 px-4 py-3.5", !n.read && "bg-emerald-50/40")}>
                  <span className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full", TYPE_STYLE[n.type] ?? TYPE_STYLE.info)}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium">{n.title}</p>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{timeAgo(n.created_at)}</span>
                    </div>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{n.message}</p>
                  </div>
                  {!n.read ? (
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        void markOne(n.id);
                      }}
                      className="self-center rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-muted"
                    >
                      Mark read
                    </button>
                  ) : null}
                </div>
              );
              return n.link ? (
                <Link key={n.id} href={n.link} className="block hover:bg-muted/40">
                  {body}
                </Link>
              ) : (
                <div key={n.id}>{body}</div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
