import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---------------- Formatting ----------------

export function formatCurrency(value: number | null | undefined): string {
  const n = Number(value ?? 0);
  const sign = n < 0 ? "-" : "";
  return `${sign}Rs ${Math.abs(n).toLocaleString("en-PK", { maximumFractionDigits: 0 })}`;
}

export function formatCurrencyPrecise(value: number | null | undefined): string {
  const n = Number(value ?? 0);
  const sign = n < 0 ? "-" : "";
  return `${sign}Rs ${Math.abs(n).toLocaleString("en-PK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatNumber(value: number | null | undefined): string {
  return Number(value ?? 0).toLocaleString("en-US");
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${value}%`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function timeAgo(value: string | null | undefined): string {
  if (!value) return "—";
  const diff = Date.now() - new Date(value).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(value);
}

export function initials(name: string): string {
  return name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------- Dates ----------------

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Date, days: number): Date {
  const c = new Date(d);
  c.setDate(c.getDate() + days);
  return c;
}

export type RangePreset =
  | "today"
  | "yesterday"
  | "7d"
  | "30d"
  | "this_month"
  | "last_month"
  | "custom"
  | "all";

export function resolveRange(preset: RangePreset, from?: string, to?: string): { from: string; to: string } {
  const now = new Date();
  switch (preset) {
    case "today":
      return { from: toISODate(now), to: toISODate(now) };
    case "yesterday": {
      const y = addDays(now, -1);
      return { from: toISODate(y), to: toISODate(y) };
    }
    case "7d":
      return { from: toISODate(addDays(now, -6)), to: toISODate(now) };
    case "30d":
      return { from: toISODate(addDays(now, -29)), to: toISODate(now) };
    case "this_month":
      return { from: toISODate(new Date(now.getFullYear(), now.getMonth(), 1)), to: toISODate(now) };
    case "last_month":
      return {
        from: toISODate(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
        to: toISODate(new Date(now.getFullYear(), now.getMonth(), 0)),
      };
    case "custom":
      return { from: from || toISODate(addDays(now, -29)), to: to || toISODate(now) };
    default:
      return { from: "2000-01-01", to: toISODate(addDays(now, 1)) };
  }
}

// ---------------- CSV ----------------

export function toCSV(columns: { key: string; label: string }[], rows: Record<string, unknown>[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map((c) => esc(c.label)).join(",");
  const lines = rows.map((r) => columns.map((c) => esc(r[c.key])).join(","));
  return [header, ...lines].join("\n");
}

// ---------------- Validation helpers ----------------

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isValidPhone(phone: string): boolean {
  return /^[0-9+\-\s()]{7,20}$/.test(phone);
}

export function isValidPercent(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n <= 100;
}
