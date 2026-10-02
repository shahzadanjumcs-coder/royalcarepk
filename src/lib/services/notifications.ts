import { store } from "@/lib/store";

type NotificationType = "info" | "success" | "warning" | "error";

/** user_id = null targets all admin-side users (rendered in the admin bell). */
export async function notify(params: {
  userId: string | null;
  title: string;
  message: string;
  type?: NotificationType;
  link?: string | null;
}): Promise<void> {
  try {
    await store.insert("notifications", {
      user_id: params.userId,
      title: params.title,
      message: params.message,
      type: params.type ?? "info",
      link: params.link ?? null,
      read: false,
    });
  } catch (e) {
    console.error("[notify] failed:", e);
  }
}

export async function notifyAdmins(params: {
  title: string;
  message: string;
  type?: NotificationType;
  link?: string | null;
}): Promise<void> {
  return notify({ ...params, userId: null });
}

export async function notifyWorker(
  workerId: string,
  params: { title: string; message: string; type?: NotificationType; link?: string | null }
): Promise<void> {
  return notify({ ...params, userId: workerId });
}
