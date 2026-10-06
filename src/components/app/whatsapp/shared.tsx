"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Status badge for WhatsApp account connection state. */
export function WAConnectionBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    connected: { label: "Connected", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    connecting: { label: "Connecting…", cls: "bg-amber-50 text-amber-700 border-amber-200" },
    disconnected: { label: "Disconnected", cls: "bg-zinc-100 text-zinc-500 border-zinc-200" },
  };
  const s = map[status] ?? map.disconnected;
  return (
    <Badge variant="outline" className={cn("font-medium", s.cls)}>
      {s.label}
    </Badge>
  );
}

/** Status badge for message queue rows. */
export function WAMessageStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: "bg-slate-100 text-slate-700 border-slate-200",
    processing: "bg-amber-50 text-amber-700 border-amber-200",
    sent: "bg-emerald-50 text-emerald-700 border-emerald-200",
    failed: "bg-rose-50 text-rose-700 border-rose-200",
    retrying: "bg-orange-50 text-orange-700 border-orange-200",
    cancelled: "bg-zinc-100 text-zinc-500 border-zinc-200",
  };
  return (
    <Badge variant="outline" className={cn("font-medium capitalize", map[status] ?? "")}>
      {status}
    </Badge>
  );
}

/** Badge for a notification type (BOOKED, OUT_FOR_DELIVERY, …). */
export function WANotificationTypeBadge({ type }: { type: string }) {
  const map: Record<string, string> = {
    BOOKED: "bg-sky-50 text-sky-700 border-sky-200",
    OUT_FOR_DELIVERY: "bg-teal-50 text-teal-700 border-teal-200",
    DELIVERED: "bg-emerald-50 text-emerald-700 border-emerald-200",
    RETURNED: "bg-rose-50 text-rose-700 border-rose-200",
    SHIPPER_ADVISE: "bg-violet-50 text-violet-700 border-violet-200",
  };
  return (
    <Badge variant="outline" className={cn("font-medium whitespace-nowrap", map[type] ?? "")}>
      {type.replace(/_/g, " ")}
    </Badge>
  );
}

/** Compact relative time ("just now", "4m ago", "2h ago", date). */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 15 * 1000) return "just now";
  if (diff < 60 * 1000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

/** Show a normalized WhatsApp number nicely (923001234567 -> +92 300 1234567). */
export function prettyPhone(digits: string | null | undefined): string {
  if (!digits) return "—";
  if (digits.includes("@")) return digits; // group JID
  if (/^92\d{10}$/.test(digits)) {
    return `+${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5)}`;
  }
  return `+${digits}`;
}
