import type { MetadataRoute } from "next";
import { getBranding } from "@/lib/services/branding";

/** PWA manifest driven by the live branding configuration. */
export const dynamic = "force-dynamic";

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const branding = await getBranding();
  return {
    name: `${branding.brand_name} — ${branding.tagline ?? "Business Console"}`,
    short_name: branding.brand_name,
    description: "Courier business management: orders, COD bookings, commissions, inventory and reports.",
    start_url: "/",
    display: "standalone",
    background_color: branding.secondary_color,
    theme_color: branding.secondary_color,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
