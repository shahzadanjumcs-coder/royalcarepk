import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getFlashipConfig, syncOrderTracking } from "@/lib/flaship/service";
import { store } from "@/lib/store";
import type { Order } from "@/lib/types";

/**
 * Vercel Cron entry point for AUTOMATIC Flaship tracking sync.
 *
 * Scheduled by vercel.json ("crons"; any external pinger that sends the same
 * Authorization header also works — the handler is trigger-agnostic).
 *
 * Design contract (approved plan, WA-PLAN-1) — deliberately minimal:
 *   - REUSES the existing syncOrderTracking() untouched: same checkpoint
 *     persistence, same status cascade, same WhatsApp enqueue pipeline.
 *   - Repeated syncs are idempotent by existing guarantees (shipment_tracking
 *     status+date dedupe, WhatsApp dedupe_key UNIQUE, commission ledger
 *     idempotency), so overlapping runs and retries are safe.
 *   - Respects the Flaship settings gate: runs only when mode === "live" AND
 *     auto_sync_tracking !== false (the previously-dead config flag).
 *   - Fail-closed auth: without a correct "Authorization: Bearer ${CRON_SECRET}"
 *     header the endpoint answers 401 and never touches the store. Vercel Cron
 *     sends that header automatically when the CRON_SECRET env var is set.
 *   - Bounded batch (oldest-synced-first) so one invocation can never stampede
 *     the Flaship API; failures are isolated per order and reported in the
 *     JSON summary — one bad CN cannot abort the whole run.
 *
 * Existing behaviour is NOT modified here: manual Sync / Bulk Sync buttons,
 * booking/catalog flows, the WhatsApp bot and all business rules stay as-is.
 */

export const dynamic = "force-dynamic";

/** Max orders synced per invocation (bounded batch). */
const BATCH_LIMIT = 20;
/** Wall-clock budget per invocation; remaining orders are left for the next tick. */
const TIME_BUDGET_MS = 45_000;
/** Terminal RoyalCarePK statuses — tracking sync is pointless for these. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["DELIVERED", "RETURNED", "CANCELLED"]);

/** Constant-time comparison so response timing cannot leak the secret. */
function secureCompare(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Burn one comparison anyway so mismatched-length requests keep the same
    // timing profile as the comparison path.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function unauthorized(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 401 });
}

export async function GET(request: Request): Promise<NextResponse> {
  // ---- 1. Fail-closed bearer auth ------------------------------------------
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return unauthorized("CRON_SECRET is not configured; automatic tracking sync is disabled (fail-closed).");
  }
  const header = request.headers.get("authorization") ?? "";
  if (!secureCompare(header, `Bearer ${secret}`)) {
    return unauthorized("Invalid or missing cron credentials.");
  }

  // ---- 2. Respect the Flaship settings gate ---------------------------------
  const cfg = await getFlashipConfig();
  if (cfg.mode !== "live") {
    return NextResponse.json({
      ok: true,
      enabled: false,
      reason: `Flaship mode is "${cfg.mode}"; automatic tracking sync runs only in live mode.`,
    });
  }
  if (cfg.auto_sync_tracking === false) {
    return NextResponse.json({
      ok: true,
      enabled: false,
      reason: "auto_sync_tracking is disabled in Flaship settings.",
    });
  }

  // ---- 3. Candidate selection ----------------------------------------------
  // booked Flaship orders that are not terminal yet. The shared store API has
  // no not-in / not-null filter, so two bounded queries are merged and the
  // terminal / un-booked rows are filtered in memory. Never-synced orders
  // (last_synced_at IS NULL) go first, then oldest-synced-first.
  const [neverSynced, recentlyStale] = await Promise.all([
    store.list<Order>("orders", {
      filters: { booking_status: "booked" },
      nullFilters: ["last_synced_at"],
      orderBy: { field: "booked_at", dir: "asc" },
      perPage: BATCH_LIMIT,
    }),
    store.list<Order>("orders", {
      filters: { booking_status: "booked" },
      orderBy: { field: "last_synced_at", dir: "asc" },
      perPage: BATCH_LIMIT,
    }),
  ]);

  const seen = new Set<string>();
  const candidates: Array<Order & { id: string }> = [];
  for (const order of [...neverSynced.rows, ...recentlyStale.rows]) {
    if (candidates.length >= BATCH_LIMIT) break;
    if (seen.has(order.id)) continue;
    seen.add(order.id);
    if (!order.flaship_booking_id || !order.tracking_number) continue; // no CN -> nothing to poll
    if (TERMINAL_STATUSES.has(order.status)) continue; // delivered/returned/cancelled
    candidates.push(order);
  }

  // ---- 4. Sequential sync with per-order isolation --------------------------
  const startedAt = Date.now();
  const results: Array<Record<string, unknown>> = [];
  let synced = 0;
  let statusUpdated = 0;
  let failed = 0;
  let stoppedEarly = false;

  for (const order of candidates) {
    if (results.length > 0 && Date.now() - startedAt > TIME_BUDGET_MS) {
      stoppedEarly = true; // leave the rest for the next scheduled tick
      break;
    }
    try {
      const r = await syncOrderTracking(null, order.id);
      synced += 1;
      if (r.applied) statusUpdated += 1;
      results.push({
        order_id: order.id,
        order_number: order.order_number,
        tracking_number: order.tracking_number,
        applied: r.applied,
        message: r.message,
      });
    } catch (e) {
      failed += 1;
      results.push({
        order_id: order.id,
        order_number: order.order_number,
        tracking_number: order.tracking_number,
        applied: false,
        error: e instanceof Error ? e.message : "Unknown tracking sync error",
      });
    }
  }

  return NextResponse.json({
    ok: true,
    enabled: true,
    checked: candidates.length,
    synced,
    status_updated: statusUpdated,
    failed,
    stopped_early: stoppedEarly,
    duration_ms: Date.now() - startedAt,
    results,
  });
}
