"use client";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface RangeValue {
  preset: string;
  from?: string;
  to?: string;
}

const PRESETS: { value: string; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "custom", label: "Custom range" },
  { value: "all", label: "All time" },
];

export function RangeFilter({
  value,
  onChange,
  className,
}: {
  value: RangeValue;
  onChange: (v: RangeValue) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2 no-print", className)}>
      <div className="flex flex-wrap gap-1">
        {PRESETS.map((p) => (
          <Button
            key={p.value}
            size="sm"
            variant={value.preset === p.value ? "default" : "outline"}
            className="h-8 rounded-full px-3 text-xs"
            onClick={() => onChange({ preset: p.value, ...(p.value === "custom" ? { from: value.from, to: value.to } : {}) })}
          >
            {p.label}
          </Button>
        ))}
      </div>
      {value.preset === "custom" ? (
        <div className="flex items-center gap-1.5">
          <Input
            type="date"
            value={value.from ?? ""}
            onChange={(e) => onChange({ ...value, from: e.target.value })}
            className="h-8 w-[140px] text-xs"
            aria-label="From date"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <Input
            type="date"
            value={value.to ?? ""}
            onChange={(e) => onChange({ ...value, to: e.target.value })}
            className="h-8 w-[140px] text-xs"
            aria-label="To date"
          />
        </div>
      ) : null}
    </div>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={cn("relative no-print", className)}>
      <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pl-8 pr-8 h-9"
        aria-label={placeholder}
      />
      {value ? (
        <button
          onClick={() => onChange("")}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          aria-label="Clear search"
        >
          <X className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}
