import { ok, fail, withAuth } from "@/lib/api/helpers";
import { store } from "@/lib/store";
import type { WhatsAppCommand } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/whatsapp/commands/[id] — poll a command's result (test sends, group listing). */
export const GET = withAuth(["super_admin", "admin"], async (_session, _req, ctx) => {
  const { id } = await (ctx as unknown as Ctx).params;
  const cmd = await store.get<WhatsAppCommand>("whatsapp_commands", id);
  if (!cmd) return fail("Command not found.", 404);
  return ok({ command: cmd });
});
