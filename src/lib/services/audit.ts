import { store } from "@/lib/store";
export interface Actor { userId?: string; name?: string; role?: string }

/** Record an audit trail entry. Never throws — audit logging must not break business flows. */
export async function logAudit(params: {
  session: Actor | null;
  action: string;
  entity: string;
  entityId?: string | null;
  oldData?: Record<string, unknown> | null;
  newData?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    await store.insert("audit_logs", {
      user_id: params.session?.userId ?? null,
      user_name: params.session?.name ?? "system",
      action: params.action,
      entity: params.entity,
      entity_id: params.entityId ?? null,
      old_data: params.oldData ?? null,
      new_data: params.newData ?? null,
    });
  } catch (e) {
    console.error("[audit] failed:", e);
  }
}
