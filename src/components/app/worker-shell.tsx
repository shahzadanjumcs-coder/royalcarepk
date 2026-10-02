"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { WORKER_NAV } from "./nav-config";
import { NotificationBell } from "./notification-bell";
import { BrandLogo } from "./brand-logo";
import { brandVars } from "@/lib/branding-shared";
import { api } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { cn, initials } from "@/lib/utils";
import { LogOut } from "lucide-react";
import type { Role } from "@/lib/types";
import type { BrandingConfig } from "@/lib/branding-shared";
import { ROLE_LABELS } from "@/lib/types";

export function WorkerShell({
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
  const pathname = usePathname();
  const router = useRouter();

  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  };

  const isActive = (href: string, exact?: boolean) =>
    exact ? pathname === href : pathname === href || pathname.startsWith(href + "/");

  return (
    <div className="flex min-h-screen flex-col bg-background" style={brandVars(branding)}>
      <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-border bg-card/90 px-3 backdrop-blur no-print">
        <div className="flex min-w-0 items-center gap-2">
          <BrandLogo branding={branding} variant="mobile" size={32} className="h-8 w-8 rounded-lg object-contain" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-tight">{branding.brand_name}</p>
            <p className="truncate text-[10px] leading-tight text-muted-foreground">Worker App</p>
          </div>
        </div>
        {demoMode ? (
          <span className="hidden rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700 sm:inline">
            Demo mode
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <NotificationBell role={session.role} />
          <Button variant="ghost" size="icon" className="rounded-full" onClick={() => void logout()} aria-label="Sign out">
            <LogOut className="h-5 w-5 text-muted-foreground" />
          </Button>
        </div>
      </header>

      <main className="flex-1 px-3 pb-24 pt-4 sm:px-5 sm:pb-8">{children}</main>

      {/* Mobile bottom navigation */}
      <nav
        className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-card/95 backdrop-blur sm:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        aria-label="Worker navigation"
      >
        <div className="grid grid-cols-5">
          {WORKER_NAV.map((item) => (
            <Link
              key={item.label}
              href={item.href}
              className={cn(
                "flex min-h-[56px] flex-col items-center justify-center gap-0.5 px-1 py-2 text-[10px] font-medium",
                isActive(item.href, item.exact) ? "" : "text-muted-foreground"
              )}
              style={isActive(item.href, item.exact) ? { color: "var(--brand-primary)" } : undefined}
            >
              <item.icon className="h-5 w-5" />
              {item.label}
            </Link>
          ))}
          <Link
            href="/worker/profile"
            className={cn(
              "flex min-h-[56px] flex-col items-center justify-center gap-0.5 px-1 py-2 text-[10px] font-medium",
              pathname === "/worker/profile" ? "" : "text-muted-foreground"
            )}
            style={pathname === "/worker/profile" ? { color: "var(--brand-primary)" } : undefined}
          >
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[9px] font-bold">
              {initials(session.name)}
            </span>
            Me
          </Link>
        </div>
      </nav>

      {/* Desktop quick nav */}
      <div className="fixed bottom-6 left-1/2 z-20 hidden -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-card/95 px-2 py-1.5 shadow-lg backdrop-blur sm:flex no-print">
        {WORKER_NAV.map((item) => (
          <Link
            key={item.label}
            href={item.href}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium",
              isActive(item.href, item.exact) ? "text-white" : "text-muted-foreground hover:bg-muted"
            )}
            style={isActive(item.href, item.exact) ? { backgroundColor: "var(--brand-primary)" } : undefined}
          >
            <item.icon className="h-3.5 w-3.5" />
            {item.label}
          </Link>
        ))}
        <span className="ml-1 mr-2 hidden text-[10px] text-muted-foreground md:inline">{ROLE_LABELS[session.role]}</span>
      </div>
    </div>
  );
}
