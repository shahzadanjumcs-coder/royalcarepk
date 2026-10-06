"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Bell, CheckCheck, PackageCheck } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn, timeAgo } from "@/lib/utils";

interface NotificationItem {
  id: string;
  title: string;
  message: string;
  type: string;
  link: string | null;
  read: boolean;
  created_at: string;
}

export function NotificationBell({ role }: { role: string }) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = async () => {
    try {
      const res = await api<{ rows: NotificationItem[]; unread: number }>("/api/notifications?limit=12");
      setItems(res.rows);
      setUnread(res.unread);
    } catch {
      /* silent for bell */
    }
  };

  useEffect(() => {
    let cancelled = false;
    api<{ rows: NotificationItem[]; unread: number }>("/api/notifications?limit=12")
      .then((res) => {
        if (!cancelled) {
          setItems(res.rows);
          setUnread(res.unread);
        }
      })
      .catch(() => undefined);
    timer.current = setInterval(() => void load(), 30000);
    return () => {
      cancelled = true;
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  const markAll = async () => {
    try {
      await api("/api/notifications", { method: "POST", json: { all: true } });
      void load();
    } catch (e) {
      // bell has no text surface — log; the next poll refreshes the unread badge
      console.error("[bell] mark-all failed", e);
    }
  };

  const markOne = async (id: string) => {
    try {
      await api("/api/notifications", { method: "POST", json: { id } });
      void load();
    } catch (e) {
      console.error("[bell] mark-one failed", e);
    }
  };

  const base = role === "worker" ? "/worker" : "/admin";

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative rounded-full" aria-label="Notifications">
          <Bell className="h-5 w-5" />
          {unread > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
              {unread > 9 ? "9+" : unread}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[340px] p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
          <p className="text-sm font-semibold">Notifications</p>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={markAll}>
            <CheckCheck className="mr-1 h-3.5 w-3.5" /> Mark all read
          </Button>
        </div>
        <div className="max-h-[380px] overflow-y-auto scrollbar-thin">
          {items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
              <PackageCheck className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">You&apos;re all caught up.</p>
            </div>
          ) : (
            items.map((n) => {
              const inner = (
                <div className={cn("border-b border-border/60 px-3 py-2.5", !n.read && "bg-emerald-50/40")}>
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-[13px] font-medium leading-snug">{n.title}</p>
                    {!n.read ? <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-emerald-500" /> : null}
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.message}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground/70">{timeAgo(n.created_at)}</p>
                </div>
              );
              return n.link ? (
                <Link
                  key={n.id}
                  href={n.link.startsWith("/admin") && role === "worker" ? base : n.link}
                  onClick={() => void markOne(n.id)}
                  className="block hover:bg-muted/50"
                >
                  {inner}
                </Link>
              ) : (
                <button key={n.id} onClick={() => void markOne(n.id)} className="block w-full text-left hover:bg-muted/50">
                  {inner}
                </button>
              );
            })
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
