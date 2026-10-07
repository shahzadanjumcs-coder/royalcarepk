"use client";

/**
 * Pickup Points admin UI — /admin/flaship/pickups.
 *
 * Shows the synced Flaship pickup locations TOGETHER WITH the courier mapping
 * each pickup is enabled for (Flaship's merchant_pickup_couriers, synced from
 * the official GET /catalog/ response — see refreshCatalog/extractCatalog).
 * This is exactly the mapping Flaship's booking validator enforces: booking a
 * pickup with a courier it is not mapped to is rejected with
 * "Pickup is not synced to this courier (missing
 * merchant_pickup_couriers.external_ref)."
 *
 * The mapping is intentionally READ-ONLY here: the Integration API exposes no
 * endpoint that creates or changes merchant_pickup_couriers pairs (the official
 * plugin only uses catalog/, bookings/ and orders/{cn}/tracking/), so pairs are
 * enabled on the Flaship side (merchant dashboard) and picked up here via
 * "Sync from Flaship". We never fabricate local pairs — a pair that exists only
 * in our database would still be rejected by Flaship at booking time.
 */

import { useMemo, useState } from "react";
import { api, useApi } from "@/lib/client";
import { PageHeader } from "./states";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Info, Loader2, RefreshCw } from "lucide-react";
import { formatDateTime } from "@/lib/utils";
import { couriersByPickup } from "@/lib/flaship/protocol";

interface PickupRow {
  id?: string;
  pickup_id: string;
  name: string;
  address: string | null;
  city: string | null;
  contact: string | null;
  active: boolean;
  synced_at: string | null;
}

interface CourierRow {
  courier_id: string;
  name: string;
}

interface LinkRow {
  pickup_id: string;
  courier_id: string;
}

interface CatalogResponse {
  couriers?: CourierRow[];
  pickups?: PickupRow[];
  pickup_couriers?: LinkRow[];
  mode?: string;
}

export function FlashipPickupPoints() {
  const { data, loading, error, refresh } = useApi<CatalogResponse>("/api/flaship/catalog");
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const pickups = useMemo(() => data?.pickups ?? [], [data]);
  const links = useMemo(() => data?.pickup_couriers ?? [], [data]);
  const courierNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of data?.couriers ?? []) m.set(c.courier_id, c.name || c.courier_id);
    return m;
  }, [data]);
  const mappedCouriers = useMemo(() => couriersByPickup(links), [links]);

  const sync = async () => {
    setSyncing(true);
    setMessage(null);
    try {
      // Syncing the pickup list also refreshes the courier↔pickup mapping:
      // the /catalog/ response is parsed as a whole and the merchant_pickup_couriers
      // edges are persisted alongside the pickups (see syncCatalog).
      const res = await api<{ count: number; counts?: { links?: number } }>("/api/flaship/catalog", {
        method: "POST",
        json: { type: "pickups" },
      });
      const pairs = res.counts?.links ?? 0;
      setMessage({
        kind: "ok",
        text: `Synced ${res.count} pickup location${res.count === 1 ? "" : "s"} from Flaship · ${pairs} courier-pickup pair${pairs === 1 ? "" : "s"} mapped.`,
      });
      refresh();
    } catch (e) {
      setMessage({ kind: "err", text: e instanceof Error ? e.message : "Sync failed." });
    } finally {
      setSyncing(false);
    }
  };

  const columns = ["Location", "Address", "City", "Contact", "Courier mapping", "Status", "Last synced"];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Pickup Points"
        description="Warehouses and dispatch points registered with Flaship, with the couriers each pickup is enabled for"
        actions={
          <Button onClick={sync} disabled={syncing}>
            {syncing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}
            Sync from Flaship
          </Button>
        }
      />

      {message ? (
        <div
          className={
            message.kind === "ok"
              ? "rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
              : "rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
          }
          role="status"
        >
          {message.text}
        </div>
      ) : null}
      {error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>
      ) : null}

      {!loading && pickups.length > 0 && links.length === 0 ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          No courier-pickup mapping synced yet. Press <strong>Sync from Flaship</strong> to load it. If the pair count
          stays 0, no courier is enabled for these pickups on the Flaship side yet — booking will be rejected until the
          mapping exists there.
        </div>
      ) : null}

      <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-sky-900">
        <div className="flex items-start gap-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            <p>
              <strong>Courier mapping is managed by Flaship</strong> (merchant_pickup_couriers) and refreshed from the
              official catalog on every sync — {pickups.length} pickup location{pickups.length === 1 ? "" : "s"} ·{" "}
              {links.length} courier-pickup pair{links.length === 1 ? "" : "s"} mapped.
            </p>
            <p>
              The Integration API has no endpoint to create or change these pairs, so they are read-only here. To enable
              or disable a courier for a pickup, update it in your Flaship merchant dashboard, then press Sync from
              Flaship. The booking dialogs only offer pairs that exist in this mapping.
            </p>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/60">
                {columns.map((c) => (
                  <th key={c} className="px-4 py-2.5 text-left font-semibold">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={columns.length} className="px-4 py-10 text-center text-muted-foreground">Loading…</td></tr>
              ) : pickups.length === 0 ? (
                <tr><td colSpan={columns.length} className="px-4 py-10 text-center text-muted-foreground">No pickup locations yet — press Sync from Flaship.</td></tr>
              ) : (
                pickups.map((row, i) => {
                  const couriers = mappedCouriers.get(row.pickup_id) ?? [];
                  return (
                    <tr key={row.id ?? row.pickup_id ?? i} className="border-t border-border/60 hover:bg-muted/30">
                      <td className="px-4 py-2.5 font-medium">{row.name || row.pickup_id}</td>
                      <td className="px-4 py-2.5">{row.address ?? "—"}</td>
                      <td className="px-4 py-2.5">{row.city ?? "—"}</td>
                      <td className="px-4 py-2.5">{row.contact ?? "—"}</td>
                      <td className="px-4 py-2.5">
                        {couriers.length ? (
                          <div className="flex flex-wrap gap-1">
                            {couriers.map((cid) => (
                              <Badge key={cid} variant="outline" className="bg-sky-50 text-sky-700 border-sky-200">
                                {courierNames.get(cid) ?? cid}
                              </Badge>
                            ))}
                          </div>
                        ) : (
                          <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200">
                            No courier mapped
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                          {row.active === false ? "Inactive" : "Active"}
                        </Badge>
                      </td>
                      <td className="px-4 py-2.5">{row.synced_at ? formatDateTime(row.synced_at) : "—"}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
