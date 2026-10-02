import { ok, fail, withAuth, GENERIC_ERROR } from "@/lib/api/helpers";
import {
  getBranding,
  updateBranding,
  removeBrandingAsset,
  saveBrandingAsset,
  setBrandingAsset,
  DEFAULT_BRANDING,
  type BrandingAssetKind,
} from "@/lib/services/branding";
import { logAudit } from "@/lib/services/audit";
import { getSession } from "@/lib/auth/session";

/**
 * Public branding endpoint — the login page renders branding before any
 * session exists, so GET is unauthenticated by design. It contains no secrets.
 */
export async function GET() {
  const branding = await getBranding();
  return ok({ branding });
}

const ASSET_KINDS: BrandingAssetKind[] = ["logo", "mobile_logo", "favicon"];

/** Upload / replace a branding asset (admin only). */
export const POST = withAuth(["super_admin", "admin"], async (session, req) => {
  try {
    const form = await req.formData();
    const kind = String(form.get("kind") ?? "");
    const file = form.get("file");
    if (!ASSET_KINDS.includes(kind as BrandingAssetKind)) return fail("Unknown branding asset kind.", 422);
    if (!(file instanceof File)) return fail("No file uploaded.", 422);

    const { url, storage } = await saveBrandingAsset(kind as BrandingAssetKind, file);
    const branding = await setBrandingAsset(kind as BrandingAssetKind, url);
    await logAudit({ session, action: "branding.asset_updated", entity: "settings", entityId: "branding", newData: { kind, storage } });
    return ok({ branding, storage });
  } catch (e) {
    if (e instanceof Error && /file|type|large|empty|storage/i.test(e.message)) return fail(e.message, 422);
    console.error("[branding.POST]", e);
    return fail(GENERIC_ERROR, 500);
  }
});

/** Update brand text/colors, remove assets, or restore all defaults (admin only). */
export const PATCH = withAuth(["super_admin", "admin"], async (session, req) => {
  try {
    const body = (await req.json()) as {
      action?: "remove_logo" | "remove_mobile_logo" | "remove_favicon" | "restore_defaults";
      brand_name?: string;
      tagline?: string | null;
      primary_color?: string;
      secondary_color?: string;
    };
    const sessionFull = await getSession();

    if (body.action === "restore_defaults") {
      await removeBrandingAsset("all");
      const restored = await updateBranding({
        brand_name: DEFAULT_BRANDING.brand_name,
        tagline: DEFAULT_BRANDING.tagline,
        primary_color: DEFAULT_BRANDING.primary_color,
        secondary_color: DEFAULT_BRANDING.secondary_color,
      });
      await logAudit({ session: sessionFull, action: "branding.restored_defaults", entity: "settings", entityId: "branding", newData: null });
      return ok({ branding: restored });
    }
    if (body.action === "remove_logo") {
      const branding = await removeBrandingAsset("logo");
      await logAudit({ session: sessionFull, action: "branding.asset_removed", entity: "settings", entityId: "branding", newData: { kind: "logo" } });
      return ok({ branding });
    }
    if (body.action === "remove_mobile_logo") {
      const branding = await removeBrandingAsset("mobile_logo");
      await logAudit({ session: sessionFull, action: "branding.asset_removed", entity: "settings", entityId: "branding", newData: { kind: "mobile_logo" } });
      return ok({ branding });
    }
    if (body.action === "remove_favicon") {
      const branding = await removeBrandingAsset("favicon");
      await logAudit({ session: sessionFull, action: "branding.asset_removed", entity: "settings", entityId: "branding", newData: { kind: "favicon" } });
      return ok({ branding });
    }

    const branding = await updateBranding({
      brand_name: body.brand_name,
      tagline: body.tagline,
      primary_color: body.primary_color,
      secondary_color: body.secondary_color,
    });
    await logAudit({ session: sessionFull, action: "branding.updated", entity: "settings", entityId: "branding", newData: { keys: Object.keys(updateKeys(body)) } });
    return ok({ branding });
  } catch (e) {
    console.error("[branding.PATCH]", e);
    return fail(GENERIC_ERROR, 500);
  }
});

function updateKeys(body: Record<string, unknown>): string[] {
  return Object.keys(body).filter((k) => k !== "action");
}
