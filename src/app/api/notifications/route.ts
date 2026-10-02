import { ok, fail, withAuth } from "@/lib/api/helpers";
import { store } from "@/lib/store";

export const GET = withAuth("any", async (session, req) => {
  const url = new URL(req.url);
  const limit = Math.min(50, parseInt(url.searchParams.get("limit") || "20", 10) || 20);
  const unreadOnly = url.searchParams.get("unread") === "true";

  let rows;
  if (session.role === "worker") {
    ({ rows } = await store.list("notifications", {
      filters: { user_id: session.userId, ...(unreadOnly ? { read: false } : {}) },
      orderBy: { field: "created_at", dir: "desc" },
    }));
  } else {
    // admins see the global feed (user_id null) plus anything addressed to them
    const global = await store.list("notifications", {
      filters: { user_id: null, ...(unreadOnly ? { read: false } : {}) },
      orderBy: { field: "created_at", dir: "desc" },
    });
    const own = await store.list("notifications", {
      filters: { user_id: session.userId, ...(unreadOnly ? { read: false } : {}) },
      orderBy: { field: "created_at", dir: "desc" },
    });
    rows = [...global.rows, ...own.rows]
      .sort((a, b) => ((b.created_at as string) > (a.created_at as string) ? 1 : -1));
  }
  const total = rows.length;
  const unread = rows.filter((n) => !n.read).length;
  return ok({ rows: rows.slice(0, limit), total, unread });
});

export const POST = withAuth("any", async (session, req) => {
  try {
    const { id, all } = (await req.json()) as { id?: string; all?: boolean };
    if (all) {
      const { rows } = await store.list("notifications", { filters: session.role === "worker" ? { user_id: session.userId } : { user_id: null } });
      for (const n of rows) {
        if (!n.read) await store.update("notifications", n.id as string, { read: true });
      }
      return ok({ success: true });
    }
    if (!id) return fail("Notification id is required.", 422);
    const n = await store.get("notifications", id);
    if (!n) return fail("Notification not found.", 404);
    const ownable = session.role === "worker" ? n.user_id === session.userId : true;
    if (!ownable) return fail("Not allowed.", 403);
    await store.update("notifications", id, { read: true });
    return ok({ success: true });
  } catch (e) {
    console.error("[notifications.POST]", e);
    return fail("Could not update notifications.", 500);
  }
});
