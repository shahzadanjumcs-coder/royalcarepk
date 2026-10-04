"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const ORDER_STATUS_STYLES: Record<string, string> = {
  CREATED: "bg-slate-100 text-slate-700 border-slate-200",
  PENDING: "bg-amber-50 text-amber-700 border-amber-200",
  ASSIGNED: "bg-violet-50 text-violet-700 border-violet-200",
  BOOKED: "bg-sky-50 text-sky-700 border-sky-200",
  IN_TRANSIT: "bg-teal-50 text-teal-700 border-teal-200",
  DELIVERED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  RETURNED: "bg-rose-50 text-rose-700 border-rose-200",
  CANCELLED: "bg-zinc-100 text-zinc-500 border-zinc-200",
};

const BOOKING_STYLES: Record<string, { label: string; cls: string }> = {
  not_booked: { label: "Not booked", cls: "bg-slate-100 text-slate-600 border-slate-200" },
  pending: { label: "Booking…", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  booked: { label: "Booked", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  failed: { label: "Booking failed", cls: "bg-rose-50 text-rose-700 border-rose-200" },
};

export function OrderStatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <Badge variant="outline" className={cn("font-medium", ORDER_STATUS_STYLES[status] ?? "", className)}>
      {status.replace(/_/g, " ")}
    </Badge>
  );
}

export function BookingStatusBadge({ status }: { status: string }) {
  const s = BOOKING_STYLES[status] ?? BOOKING_STYLES.not_booked;
  return (
    <Badge variant="outline" className={cn("font-medium", s.cls)}>
      {s.label}
    </Badge>
  );
}

export function UserStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={status === "active" ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-rose-50 text-rose-700 border-rose-200"}>
      {status === "active" ? "Active" : "Disabled"}
    </Badge>
  );
}

const APPROVAL_STYLES: Record<string, string> = {
  PENDING: "bg-amber-50 text-amber-700 border-amber-200",
  APPROVED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  REJECTED: "bg-rose-50 text-rose-700 border-rose-200",
};

const APPROVAL_LABELS: Record<string, string> = {
  PENDING: "Pending Approval",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

export function ApprovalStatusBadge({ status, className }: { status?: string | null; className?: string }) {
  const s = status ?? "APPROVED";
  return (
    <Badge variant="outline" className={cn("font-medium", APPROVAL_STYLES[s] ?? "", className)}>
      {APPROVAL_LABELS[s] ?? s}
    </Badge>
  );
}

const MOVEMENT_STYLES: Record<string, string> = {
  PURCHASE: "bg-emerald-50 text-emerald-700 border-emerald-200",
  STOCK_IN: "bg-emerald-50 text-emerald-700 border-emerald-200",
  STOCK_OUT: "bg-rose-50 text-rose-700 border-rose-200",
  ORDER_RESERVE: "bg-amber-50 text-amber-700 border-amber-200",
  ORDER_RELEASE: "bg-zinc-100 text-zinc-600 border-zinc-200",
  DELIVERY: "bg-teal-50 text-teal-700 border-teal-200",
  RETURN: "bg-violet-50 text-violet-700 border-violet-200",
  ADJUSTMENT: "bg-sky-50 text-sky-700 border-sky-200",
};

export function MovementBadge({ type }: { type: string }) {
  return (
    <Badge variant="outline" className={cn("font-medium", MOVEMENT_STYLES[type] ?? "")}>
      {type.replace(/_/g, " ")}
    </Badge>
  );
}

export function CommissionTypeBadge({ type }: { type: string }) {
  const map: Record<string, string> = {
    DELIVERED_COMMISSION: "bg-emerald-50 text-emerald-700 border-emerald-200",
    RETURN_ADJUSTMENT: "bg-rose-50 text-rose-700 border-rose-200",
    MANUAL_ADJUSTMENT: "bg-amber-50 text-amber-700 border-amber-200",
  };
  return (
    <Badge variant="outline" className={cn("font-medium", map[type] ?? "")}>
      {type.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())}
    </Badge>
  );
}
