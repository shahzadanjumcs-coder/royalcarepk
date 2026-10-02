"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { type LucideIcon } from "lucide-react";

const TINTS: Record<string, string> = {
  emerald: "bg-emerald-100 text-emerald-700",
  amber: "bg-amber-100 text-amber-700",
  rose: "bg-rose-100 text-rose-700",
  teal: "bg-teal-100 text-teal-700",
  violet: "bg-violet-100 text-violet-700",
  sky: "bg-sky-100 text-sky-700",
  slate: "bg-slate-100 text-slate-700",
};

export function StatCard({
  label,
  value,
  icon: Icon,
  tint = "emerald",
  hint,
  loading,
  className,
}: {
  label: string;
  value: string | number;
  icon: LucideIcon;
  tint?: keyof typeof TINTS;
  hint?: string;
  loading?: boolean;
  className?: string;
}) {
  return (
    <Card className={cn("border-border/70 shadow-sm", className)}>
      <CardContent className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-muted-foreground truncate">{label}</p>
            {loading ? (
              <Skeleton className="mt-2 h-7 w-24" />
            ) : (
              <p className="mt-1 truncate text-xl sm:text-2xl font-semibold tracking-tight text-foreground">{value}</p>
            )}
            {hint && !loading ? <p className="mt-1 text-xs text-muted-foreground truncate">{hint}</p> : null}
          </div>
          <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", TINTS[tint])}>
            <Icon className="h-5 w-5" aria-hidden="true" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
