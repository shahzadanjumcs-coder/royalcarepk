import { ok, fail, withAuth } from "@/lib/api/helpers";
import { bookOrderWithFlaship, FlashipError, getFlashipConfig } from "@/lib/flaship/service";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withAuth(["super_admin", "admin"], async () => {
  const cfg = await getFlashipConfig();
  return ok({ mode: cfg.mode, base_url: cfg.base_url });
});

export const POST = withAuth(["super_admin", "admin"], async (session, req, ctx) => {
  try {
    const { id } = await (ctx as unknown as Ctx).params;
    const body = (await req.json().catch(() => ({}))) as { courier?: string; pickup?: string; service_type?: string; city_id?: string };
    const result = await bookOrderWithFlaship(session, id, {
      courier: body.courier,
      pickup: body.pickup,
      serviceType: body.service_type,
      cityId: body.city_id,
    });
    return ok(result);
  } catch (e) {
    if (e instanceof FlashipError) return fail(e.message, 422);
    console.error("[orders.book]", e);
    return fail("Flaship booking failed. Check the booking logs and retry.", 500);
  }
});
