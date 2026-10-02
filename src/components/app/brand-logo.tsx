"use client";

import { useState } from "react";
import { Package } from "lucide-react";
import type { BrandingConfig } from "@/lib/branding-shared";

/**
 * Renders the active brand logo with graceful fallback to the built-in
 * RoyalCarePK logo — a missing/broken custom logo never shows a broken image.
 */
export function BrandLogo({
  branding,
  variant = "desktop",
  size = 36,
  className,
}: {
  branding: BrandingConfig;
  variant?: "desktop" | "mobile";
  size?: number;
  className?: string;
}) {
  const custom = variant === "mobile" ? branding.mobile_logo_url ?? branding.logo_url : branding.logo_url;
  const [stage, setStage] = useState<"custom" | "default" | "icon">(custom ? "custom" : "default");
  // adjust state when the prop changes (React-recommended render-time reset)
  const [prevCustom, setPrevCustom] = useState(custom);
  if (prevCustom !== custom) {
    setPrevCustom(custom);
    setStage(custom ? "custom" : "default");
  }

  if (stage === "custom") {
    return (
      <img
        src={custom as string}
        alt={`${branding.brand_name} logo`}
        width={size}
        height={size}
        onError={() => setStage("default")}
        className={className ?? "h-9 w-9 rounded-lg object-contain"}
      />
    );
  }
  if (stage === "default") {
    return (
      <img
        src="/logo.svg"
        alt={`${branding.brand_name} logo`}
        width={size}
        height={size}
        onError={() => setStage("icon")}
        className={className ?? "h-9 w-9 rounded-lg object-contain"}
      />
    );
  }
  return (
    <div
      className={className ?? "flex items-center justify-center rounded-lg"}
      style={{ width: size, height: size, backgroundColor: "color-mix(in srgb, var(--brand-primary) 18%, transparent)" }}
      aria-label={`${branding.brand_name} logo`}
    >
      <Package style={{ width: size * 0.55, height: size * 0.55, color: "var(--brand-primary)" }} />
    </div>
  );
}
