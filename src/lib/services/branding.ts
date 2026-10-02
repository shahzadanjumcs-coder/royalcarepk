import "server-only";
import { store, IS_DEMO_MODE } from "@/lib/store";
import { getServiceRoleClient } from "@/lib/supabase/server";
import type { BrandingConfig } from "@/lib/branding-shared";

export type { BrandingConfig } from "@/lib/branding-shared";

/**
 * Dynamic branding system.
 *
 * Branding is stored in the `settings` table (key = "branding") so admins can
 * change it at runtime — nothing user-facing is hardcoded. Uploaded assets go
 * to Supabase Storage (live mode) or are inlined as validated data URLs
 * (demo mode). Workers may READ branding but only Super Admins/Admins change it.
 */

export type BrandingAssetKind = "logo" | "mobile_logo" | "favicon";

export const DEFAULT_BRANDING: BrandingConfig = {
  brand_name: "RoyalCarePK",
  tagline: "Business Console",
  logo_url: null, // null → built-in default logo (/logo.svg)
  mobile_logo_url: null,
  favicon_url: null, // null → built-in default icon (/icon.svg)
  primary_color: "#10b981",
  secondary_color: "#0f172a",
};

export const BRANDING_LIMITS = {
  /** max upload size in bytes */
  max_logo_bytes: 400 * 1024,
  max_favicon_bytes: 200 * 1024,
  allowed_logo_mimes: ["image/png", "image/jpeg", "image/webp", "image/svg+xml"],
  allowed_favicon_mimes: ["image/png", "image/x-icon", "image/vnd.microsoft.icon", "image/svg+xml", "image/webp"],
};

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export async function getBranding(): Promise<BrandingConfig> {
  try {
    const row = await store.first<{ value: Partial<BrandingConfig> }>("settings", { key: "branding" });
    const v = row?.value ?? {};
    return {
      ...DEFAULT_BRANDING,
      ...v,
      brand_name: (v.brand_name ?? DEFAULT_BRANDING.brand_name).slice(0, 60),
      tagline: v.tagline ? String(v.tagline).slice(0, 120) : null,
    };
  } catch {
    return DEFAULT_BRANDING;
  }
}

function sanitize(input: Partial<BrandingConfig>): Partial<BrandingConfig> {
  const out: Partial<BrandingConfig> = {};
  if (typeof input.brand_name === "string" && input.brand_name.trim()) out.brand_name = input.brand_name.trim().slice(0, 60);
  if ("tagline" in input) out.tagline = input.tagline ? String(input.tagline).slice(0, 120) : null;
  if (typeof input.primary_color === "string" && HEX_RE.test(input.primary_color)) out.primary_color = input.primary_color.toLowerCase();
  if (typeof input.secondary_color === "string" && HEX_RE.test(input.secondary_color)) out.secondary_color = input.secondary_color.toLowerCase();
  return out;
}

/** Persist text/color changes. Returns the updated branding. */
export async function updateBranding(patch: Partial<BrandingConfig>): Promise<BrandingConfig> {
  const current = await getBranding();
  const clean = sanitize(patch);
  const next: BrandingConfig = { ...current, ...clean, updated_at: new Date().toISOString() };
  const existing = await store.first("settings", { key: "branding" });
  if (existing) await store.update("settings", existing.id, { value: next, updated_at: next.updated_at });
  else await store.insert("settings", { key: "branding", value: next });
  return next;
}

/** Remove an uploaded asset (falls back to the built-in default). */
export async function removeBrandingAsset(kind: BrandingAssetKind | "all"): Promise<BrandingConfig> {
  const current = await getBranding();
  const next: BrandingConfig = { ...current, updated_at: new Date().toISOString() };
  if (kind === "logo" || kind === "all") next.logo_url = null;
  if (kind === "mobile_logo" || kind === "all") next.mobile_logo_url = null;
  if (kind === "favicon" || kind === "all") next.favicon_url = null;
  const existing = await store.first("settings", { key: "branding" });
  if (existing) await store.update("settings", existing.id, { value: next, updated_at: next.updated_at });
  else await store.insert("settings", { key: "branding", value: next });
  return next;
}

function safeExtension(mime: string, originalName: string): string {
  const byMime: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/x-icon": "ico",
    "image/vnd.microsoft.icon": "ico",
  };
  if (byMime[mime]) return byMime[mime];
  const ext = originalName.split(".").pop()?.toLowerCase() ?? "";
  return ["png", "jpg", "jpeg", "webp", "svg", "ico"].includes(ext) ? ext : "png";
}

/**
 * Store an uploaded branding asset.
 * - Live mode: uploads to the public `branding` Supabase Storage bucket (server-side only).
 * - Demo mode: inlines the image as a data URL inside the settings row.
 * Returns a URL usable from the browser.
 */
export async function saveBrandingAsset(kind: BrandingAssetKind, file: File): Promise<{ url: string; storage: "supabase" | "data-url" }> {
  const mime = (file.type || "").toLowerCase();
  const allowed = kind === "favicon" ? BRANDING_LIMITS.allowed_favicon_mimes : BRANDING_LIMITS.allowed_logo_mimes;
  if (!allowed.includes(mime)) {
    throw new Error(`Unsupported file type (${mime || "unknown"}). Use ${kind === "favicon" ? "PNG, ICO, SVG or WEBP" : "PNG, JPG, SVG or WEBP"}.`);
  }
  const limit = kind === "favicon" ? BRANDING_LIMITS.max_favicon_bytes : BRANDING_LIMITS.max_logo_bytes;
  if (file.size > limit) throw new Error(`File is too large. Maximum ${Math.round(limit / 1024)} KB.`);
  if (file.size === 0) throw new Error("The selected file is empty.");

  const buffer = Buffer.from(await file.arrayBuffer());
  const ext = safeExtension(mime, file.name);

  // Live mode: Supabase Storage
  if (!IS_DEMO_MODE) {
    const client = getServiceRoleClient();
    if (client) {
      const path = `${kind}-${Date.now()}.${ext}`;
      const { error } = await client.storage.from("branding").upload(path, buffer, {
        contentType: mime,
        cacheControl: "3600",
        upsert: false,
      });
      if (!error) {
        const { data } = client.storage.from("branding").getPublicUrl(path);
        if (data?.publicUrl) return { url: data.publicUrl, storage: "supabase" };
      } else {
        throw new Error(`Storage upload failed: ${error.message}`);
      }
    }
  }

  // Demo mode (or storage unavailable): validated inline data URL
  const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
  return { url: dataUrl, storage: "data-url" };
}

/** Apply an uploaded (or cleared) asset to the branding config. */
export async function setBrandingAsset(kind: BrandingAssetKind, url: string | null): Promise<BrandingConfig> {
  const current = await getBranding();
  const next: BrandingConfig = { ...current, updated_at: new Date().toISOString() };
  if (kind === "logo") next.logo_url = url;
  if (kind === "mobile_logo") next.mobile_logo_url = url;
  if (kind === "favicon") next.favicon_url = url;
  const existing = await store.first("settings", { key: "branding" });
  if (existing) await store.update("settings", existing.id, { value: next, updated_at: next.updated_at });
  else await store.insert("settings", { key: "branding", value: next });
  return next;
}
