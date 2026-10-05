import { ok, fail, withAuth, GENERIC_ERROR } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import { normalizePkWhatsApp } from "@/lib/services/whatsapp";
import type { WhatsAppAdminRecipient } from "@/lib/types";

/** GET /api/whatsapp/recipients — admin recipient numbers (RETURNED alerts + others). */
export const GET = withAuth(["super_admin", "admin"], async () => {
  const { rows } = await store.list<WhatsAppAdminRecipient>("whatsapp_admin_recipients", {
    orderBy: { field: "created_at", dir: "asc" },
    perPage: 100,
  });
  return ok({ rows });
});

/** POST /api/whatsapp/recipients — {label, phone} */
export const POST = withAuth(["super_admin", "admin"], async (_session, req) => {
  try {
    const body = (await req.json().catch(() => ({}))) as { label?: string; phone?: string };
    const label = String(body.label ?? "").trim() || "Admin";
    const normalized = normalizePkWhatsApp(body.phone);
    if (!normalized.valid) return fail(normalized.reason ?? "Enter a valid WhatsApp number (03XX… / +92XX… / 92XX…).", 422);
    const dupe = await store.first("whatsapp_admin_recipients", { phone: normalized.digits });
    if (dupe) return fail("This number is already in the admin recipients list.", 409);
    const row = await store.insert<WhatsAppAdminRecipient>("whatsapp_admin_recipients", {
      label,
      phone: normalized.digits,
      enabled: true,
    });
    return ok({ recipient: row }, 201);
  } catch (e) {
    console.error("[whatsapp.recipients.create]", e);
    return fail(GENERIC_ERROR, 500);
  }
});

/** PATCH /api/whatsapp/recipients — {id, label?, phone?, enabled?} */
export const PATCH = withAuth(["super_admin", "admin"], async (_session, req) => {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      id?: string;
      label?: string;
      phone?: string;
      enabled?: boolean;
    };
    if (!body.id) return fail("Recipient id is required.", 422);
    const payload: Record<string, unknown> = {};
    if (body.label !== undefined) payload.label = String(body.label).trim() || "Admin";
    if (body.phone !== undefined) {
      const normalized = normalizePkWhatsApp(body.phone);
      if (!normalized.valid) return fail(normalized.reason ?? "Invalid WhatsApp number.", 422);
      payload.phone = normalized.digits;
    }
    if (body.enabled !== undefined) payload.enabled = !!body.enabled;
    const row = await store.update<WhatsAppAdminRecipient>("whatsapp_admin_recipients", body.id, payload);
    return ok({ recipient: row });
  } catch (e) {
    console.error("[whatsapp.recipients.patch]", e);
    return fail(GENERIC_ERROR, 500);
  }
});

/** DELETE /api/whatsapp/recipients?id=… */
export const DELETE = withAuth(["super_admin", "admin"], async (_session, req) => {
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return fail("Recipient id is required.", 422);
    await store.delete("whatsapp_admin_recipients", id);
    return ok({ ok: true });
  } catch (e) {
    console.error("[whatsapp.recipients.delete]", e);
    return fail(GENERIC_ERROR, 500);
  }
});
