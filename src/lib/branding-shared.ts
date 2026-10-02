import type { CSSProperties } from "react";

/**
 * Branding shape shared between server and client code.
 * (The server-side service in lib/services/branding.ts re-exports this type.)
 */
export interface BrandingConfig {
  brand_name: string;
  tagline: string | null;
  logo_url: string | null;
  mobile_logo_url: string | null;
  favicon_url: string | null;
  primary_color: string;
  secondary_color: string;
  updated_at?: string;
}

/** Inline style helper that publishes brand colors as CSS variables. */
export function brandVars(branding: BrandingConfig): CSSProperties {
  return {
    ["--brand-primary" as string]: branding.primary_color,
    ["--brand-secondary" as string]: branding.secondary_color,
  } as CSSProperties;
}
