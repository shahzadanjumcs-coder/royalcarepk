import { ok, fail, withAuth, GENERIC_ERROR } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import { getFlashipConfig, getFlashipKeyHint, saveFlashipSettings } from "@/lib/flaship/service";
import { encryptSecret } from "@/lib/crypto/secret-box";
import { logAudit } from "@/lib/services/audit";
import { getSession } from "@/lib/auth/session";

export const GET = withAuth(["super_admin", "admin", "inventory_manager"], async () => {
  const { rows } = await store.list("settings");
  const flaship = await getFlashipConfig();
  const keyHint = await getFlashipKeyHint();
  const map: Record<string, unknown> = {};
  for (const r of rows) map[r.key as string] = r.value;
  // never leak the actual API key — only a masked hint + whether one is configured
  map.flaship = {
    ...(map.flaship as Record<string, unknown> | undefined),
    api_key_set: keyHint.api_key_set,
    api_key_masked: keyHint.api_key_masked,
    api_key_source: keyHint.source,
    mode: flaship.mode,
    base_url: flaship.base_url,
    endpoints: flaship.endpoints,
    timeout_ms: flaship.timeout_ms,
    default_courier: flaship.default_courier ?? null,
    default_service_type: flaship.default_service_type ?? "overnight",
    default_pickup: flaship.default_pickup ?? null,
    default_weight: flaship.default_weight ?? 0.5,
  };
  return ok({ settings: map });
});

export const PATCH = withAuth(["super_admin", "admin"], async (_session, req) => {
  try {
    const body = (await req.json()) as { key?: string; value?: Record<string, unknown> };
    if (!body.key || typeof body.value !== "object" || !body.value) return fail("Invalid settings payload.", 422);

    const value = { ...body.value };

    // Flaship settings: the API key is accepted write-only and stored AES-256-GCM
    // encrypted server-side. It is never echoed back to the browser.
    if (body.key === "flaship") {
      const plainKey = typeof value.api_key === "string" ? value.api_key.trim() : "";
      delete value.api_key;
      delete value.api_key_enc;
      delete value.api_key_masked;
      if (plainKey) {
        const enc = encryptSecret(plainKey);
        if (!enc) return fail("Could not secure the API key. Please retry.", 500);
        await saveFlashipSettings({ api_key_enc: enc });
      }
      // base URL / defaults live in the same settings row
      const stored = await store.first("settings", { key: "flaship" });
      const current = (stored?.value as Record<string, unknown>) ?? {};
      const merged = { ...current, ...value };
      await saveFlashipSettings(merged as Parameters<typeof saveFlashipSettings>[0]);
    } else {
      // strip any secret-looking fields from generic settings
      delete value.api_key;
      delete value.api_key_enc;
      const existing = await store.first("settings", { key: body.key });
      if (existing) {
        await store.update("settings", existing.id, { value, updated_at: new Date().toISOString() });
      } else {
        await store.insert("settings", { key: body.key, value });
      }
    }

    const session = await getSession();
    // audit without any secret material
    await logAudit({ session, action: "settings.updated", entity: "settings", entityId: body.key, newData: { key: body.key } });
    return ok({ success: true });
  } catch (e) {
    console.error("[settings.PATCH]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
