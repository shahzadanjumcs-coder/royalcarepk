"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useUIStore } from "@/store/ui";
import { ADMIN_NAV } from "./nav-config";
import { NotificationBell } from "./notification-bell";
import { BrandLogo } from "./brand-logo";
import { brandVars } from "@/lib/branding-shared";
import { cn, initials } from "@/lib/utils";
import { api } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { LogOut, Menu, PanelLeftClose, Settings, X } from "lucide-react";
import type { Role } from "@/lib/types";
import type { BrandingConfig } from "@/lib/branding-shared";
import { ROLE_LABELS } from "@/lib/types";

function NavLink({
  href,
  label,
  icon: Icon,
  exact,
  active,
  onNavigate,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  exact?: boolean;
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className={cn(
        "group flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-primary-foreground"
          : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
      )}
    >
      <Icon className="h-4 w-4 shrink-0" style={active ? { color: "var(--brand-primary)" } : undefined} />
      <span className="truncate">{label}</span>
      {active ? <span className="ml-auto h-1.5 w-1.5 rounded-full" style={{ backgroundColor: "var(--brand-primary)" }} /> : null}
    </Link>
  );
}

function SidebarContent({ role, branding, onNavigate }: { role: Role; branding: BrandingConfig; onNavigate?: () => void }) {
  const pathname = usePathname();
  const search = typeof window !== "undefined" ? window.location.search : "";
  const isActive = (href: string, exact?: boolean) => {
    const [path, query] = href.split("?");
    if (query) return pathname === path && search.includes(query);
    if (exact) return pathname === path;
    return pathname === path || pathname.startsWith(path + "/");
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center gap-2.5 border-b border-sidebar-border px-4">
        <BrandLogo branding={branding} size={34} className="h-[34px] w-[34px] rounded-lg object-contain" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold leading-tight text-sidebar-primary-foreground">{branding.brand_name}</p>
          <p className="truncate text-[10px] leading-tight text-sidebar-foreground/50">{branding.tagline ?? "Business Console"}</p>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto scrollbar-thin px-2.5 py-3" aria-label="Main navigation">
        {ADMIN_NAV.filter((section) => !section.roles || section.roles.includes(role)).map((section, i) => (
          <div key={i} className="mb-3">
            {section.title ? (
              <p className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/40">
                {section.title}
              </p>
            ) : null}
            <div className="space-y-0.5">
              {section.items.map((item) => (
                <NavLink key={item.label} {...item} active={isActive(item.href, item.exact)} onNavigate={onNavigate} />
              ))}
            </div>
          </div>
        ))}
      </nav>
      <div className="border-t border-sidebar-border px-4 py-3">
        <p className="text-[10px] text-sidebar-foreground/40">{branding.brand_name} v1.0 — Flaship integrated</p>
      </div>
    </div>
  );
}

export function AdminShell({
  children,
  session,
  demoMode,
  branding,
}: {
  children: React.ReactNode;
  session: { name: string; email: string; role: Role };
  demoMode: boolean;
  branding: BrandingConfig;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();
  const router = useRouter();

  const logout = async () => {
    // Navigation must always happen — even if the API call fails, the user
    // asked to leave; a trapped spinner would be worse than a stale cookie.
    try {
      await api("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  };

  const currentTitle = (() => {
    for (const section of ADMIN_NAV) {
      for (const item of section.items) {
        const [path, query] = item.href.split("?");
        const match = query ? pathname === path : pathname === path || pathname.startsWith(path + "/");
        if (match) return query ? item.label : item.label;
      }
    }
    return "Dashboard";
  })();

  return (
    <div className="flex min-h-screen bg-background" style={brandVars(branding)}>
      {/* Desktop sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-30 hidden border-r border-sidebar-border bg-sidebar transition-all duration-200 lg:block",
          collapsed ? "w-[68px]" : "w-64"
        )}
      >
        <SidebarContent role={session.role} branding={branding} />
      </aside>

      {/* Mobile sidebar */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-72 border-sidebar-border bg-sidebar p-0 [&>button]:hidden">
          <SheetTitle className="sr-only">Navigation menu</SheetTitle>
          <SidebarContent role={session.role} branding={branding} onNavigate={() => setMobileOpen(false)} />
          <button
            onClick={() => setMobileOpen(false)}
            className="absolute right-3 top-3 rounded-md p-1 text-sidebar-foreground/60 hover:text-sidebar-foreground"
            aria-label="Close menu"
          >
            <X className="h-4 w-4" />
          </button>
        </SheetContent>
      </Sheet>

      {/* Main column */}
      <div className={cn("flex min-h-screen w-full flex-col transition-all duration-200", collapsed ? "lg:pl-[68px]" : "lg:pl-64")}>
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-border bg-card/90 px-3 backdrop-blur sm:px-5 no-print">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="rounded-full lg:hidden" aria-label="Open menu">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 border-sidebar-border bg-sidebar p-0 [&>button]:hidden">
              <SheetTitle className="sr-only">Navigation menu</SheetTitle>
              <SidebarContent role={session.role} branding={branding} />
            </SheetContent>
          </Sheet>

          <h2 className="truncate text-sm font-semibold text-foreground sm:text-base">{currentTitle}</h2>

          {demoMode ? (
            <Badge variant="outline" className="hidden bg-amber-50 text-[10px] text-amber-700 border-amber-200 sm:inline-flex">
              Demo mode — connect Supabase for production
            </Badge>
          ) : null}

          <div className="ml-auto flex items-center gap-1.5">
            <NotificationBell role={session.role} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="h-9 gap-2 rounded-full px-2">
                  <span
                    className="flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold text-white"
                    style={{ backgroundColor: "var(--brand-primary)" }}
                  >
                    {initials(session.name)}
                  </span>
                  <span className="hidden text-left sm:block">
                    <span className="block text-xs font-semibold leading-tight">{session.name}</span>
                    <span className="block text-[10px] leading-tight text-muted-foreground">{ROLE_LABELS[session.role]}</span>
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel>
                  <p className="text-sm font-medium">{session.name}</p>
                  <p className="text-xs font-normal text-muted-foreground">{session.email}</p>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => router.push("/admin/settings")}>
                  <Settings className="mr-2 h-4 w-4" /> Settings
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setCollapsed((c) => !c)} className="hidden lg:flex">
                  <PanelLeftClose className="mr-2 h-4 w-4" /> {collapsed ? "Expand" : "Collapse"} sidebar
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => void logout()} className="text-rose-600 focus:text-rose-600">
                  <LogOut className="mr-2 h-4 w-4" /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <main className="flex-1 px-3 py-4 sm:px-5 sm:py-6">{children}</main>

        <footer className="border-t border-border px-5 py-3 text-center text-xs text-muted-foreground no-print">
          {branding.brand_name} — team, orders, inventory &amp; commissions in one place
        </footer>
      </div>
    </div>
  );
}
