"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(path, {
    ...rest,
    headers: { "Content-Type": "application/json", ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError((data as { error?: string }).error ?? "Something went wrong. Please try again.", res.status);
  }
  return data as T;
}

export function buildQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "" || v === "ALL") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export interface PaginatedResponse<T> {
  rows: T[];
  total: number;
  page: number;
  perPage: number;
}

/** Fetch a list endpoint with loading / error / refresh + pagination state. */
export function useList<T>(endpoint: string, deps: unknown[] = [], options?: { enabled?: boolean }) {
  const enabled = options?.enabled !== false;
  const depKey = deps.join("|");
  const [data, setData] = useState<PaginatedResponse<T> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const run = async () => {
      try {
        const res = await api<PaginatedResponse<T>>(endpoint);
        if (!cancelled && mounted.current) {
          setData(res);
          setError(null);
        }
      } catch (e) {
        if (!cancelled && mounted.current) setError(e instanceof Error ? e.message : "Request failed.");
      } finally {
        if (!cancelled && mounted.current) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [endpoint, enabled, tick, depKey]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, refresh, setData };
}

/** Fetch any JSON endpoint with loading / error / refresh. */
export function useApi<T>(endpoint: string, deps: unknown[] = [], options?: { enabled?: boolean }) {
  const enabled = options?.enabled !== false;
  const depKey = deps.join("|");
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const run = async () => {
      try {
        const res = await api<T>(endpoint);
        if (!cancelled && mounted.current) {
          setData(res);
          setError(null);
        }
      } catch (e) {
        if (!cancelled && mounted.current) setError(e instanceof Error ? e.message : "Request failed.");
      } finally {
        if (!cancelled && mounted.current) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [endpoint, enabled, tick, depKey]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, refresh, setData };
}

export function useDebounced<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function usePagination(initialPerPage = 15) {
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(initialPerPage);
  const query = useMemo(() => ({ page, perPage }), [page, perPage]);
  return { page, setPage, perPage, setPerPage, query };
}
