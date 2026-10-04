"use client";

import { useApi } from "@/lib/client";
import type { Session } from "@/lib/types";

/**
 * Client-side session accessor (lightweight; backed by /api/auth/session).
 * Server components should use getSession() from @/lib/auth/session instead.
 */
export function useSession() {
  const { data, loading } = useApi<{ session: Session | null; mode: string }>("/api/auth/session");
  return { session: data?.session ?? null, mode: data?.mode ?? null, loading };
}
