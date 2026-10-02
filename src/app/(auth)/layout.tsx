import Link from "next/link";
import { BrandLogo } from "@/components/app/brand-logo";
import { brandVars } from "@/lib/branding-shared";
import { getBranding } from "@/lib/services/branding";

// branding must be read per-request so admin changes apply immediately
export const dynamic = "force-dynamic";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const branding = await getBranding();

  return (
    <div className="flex min-h-screen flex-col lg:flex-row" style={brandVars(branding)}>
      {/* Brand panel */}
      <div className="relative hidden flex-1 flex-col justify-between p-10 lg:flex" style={{ backgroundColor: "var(--brand-secondary)" }}>
        <div className="flex items-center gap-3">
          <BrandLogo branding={branding} size={40} className="h-10 w-10 rounded-xl object-contain" />
          <div>
            <p className="text-base font-semibold text-white">{branding.brand_name}</p>
            <p className="text-xs text-slate-400">{branding.tagline ?? "Business Console"}</p>
          </div>
        </div>
        <div className="max-w-md">
          <h2 className="text-3xl font-semibold leading-tight text-white">
            Run your courier business from one clean dashboard.
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-slate-400">
            Book COD parcels through Flaship, assign riders, track every parcel, keep inventory
            reserved and accurate, and pay commissions from a transparent ledger — all
            role-controlled and audit-logged.
          </p>
          <div className="mt-8 grid grid-cols-2 gap-3 text-xs text-slate-400">
            <div className="rounded-lg border border-white/10 bg-white/5 p-3">Server-side Flaship API</div>
            <div className="rounded-lg border border-white/10 bg-white/5 p-3">Commission ledger</div>
            <div className="rounded-lg border border-white/10 bg-white/5 p-3">Stock reservations</div>
            <div className="rounded-lg border border-white/10 bg-white/5 p-3">Role-based access</div>
          </div>
        </div>
        <p className="text-xs text-slate-500">© {new Date().getFullYear()} {branding.brand_name}. All rights reserved.</p>
      </div>

      {/* Form panel */}
      <div className="flex flex-1 items-center justify-center bg-background px-4 py-10 sm:px-6">
        <div className="w-full max-w-md">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <BrandLogo branding={branding} variant="mobile" size={40} className="h-10 w-10 rounded-xl object-contain" />
            <div>
              <p className="text-base font-semibold">{branding.brand_name}</p>
              <p className="text-xs text-muted-foreground">{branding.tagline ?? "Business Console"}</p>
            </div>
          </div>
          {children}
          <p className="mt-8 text-center text-xs text-muted-foreground">
            <Link href="/" className="hover:text-foreground">Back to home</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
