"use client";

import { useState } from "react";
import { api, useList, useDebounced, ApiError } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LoadingRows, EmptyState } from "@/components/app/states";
import { WAMessageStatusBadge, WANotificationTypeBadge, formatDateTime, prettyPhone } from "./shared";
import type { WhatsAppMessageLog, WhatsAppQueueItem } from "@/lib/types";
import { RotateCcw, Ban, Search, History, ChevronDown } from "lucide-react";

const STATUS_TABS: { key: string; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "sent", label: "Sent" },
  { key: "failed", label: "Failed" },
  { key: "pending", label: "Pending" },
  { key: "retrying", label: "Retrying" },
  { key: "cancelled", label: "Cancelled" },
];

const TYPE_OPTIONS = ["ALL", "BOOKED", "OUT_FOR_DELIVERY", "DELIVERED", "RETURNED", "SHIPPER_ADVISE"];

/**
 * Message Logs panel — every WhatsApp notification with filters, failure
 * reasons, attempt history and admin Retry for failed messages.
 */
export function WhatsAppMessagesPanel() {
  const [status, setStatus] = useState("ALL");
  const [type, setType] = useState("ALL");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebounced(search, 350);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [details, setDetails] = useState<WhatsAppQueueItem | null>(null);

  const query = new URLSearchParams({
    page: String(page),
    perPage: "15",
    ...(status !== "ALL" ? { status } : {}),
    ...(type !== "ALL" ? { f_notification_type: type } : {}),
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
  }).toString();

  const { data, loading, error, refresh } = useList<WhatsAppQueueItem>(
    `/api/whatsapp/queue?${query}`,
    [status, type, debouncedSearch, page]
  );

  async function act(item: WhatsAppQueueItem, action: "retry" | "cancel") {
    setBusyId(item.id);
    setMsg(null);
    try {
      const res = await api<{ message?: string }>(`/api/whatsapp/queue/${item.id}`, { method: "POST", json: { action } });
      setMsg({ kind: "ok", text: res.message ?? "Done." });
      refresh();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof ApiError ? e.message : "Action failed." });
    } finally {
      setBusyId(null);
    }
  }

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / 15));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {STATUS_TABS.map((t) => (
          <Button
            key={t.key}
            size="sm"
            variant={status === t.key ? "default" : "outline"}
            onClick={() => {
              setStatus(t.key);
              setPage(1);
            }}
          >
            {t.label}
          </Button>
        ))}
        <div className="relative ml-auto w-full sm:w-64">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Order / recipient / text…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <select
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          value={type}
          onChange={(e) => {
            setType(e.target.value);
            setPage(1);
          }}
          aria-label="Filter by notification type"
        >
          {TYPE_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {t === "ALL" ? "All types" : t.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      </div>

      {msg ? (
        <Alert variant={msg.kind === "err" ? "destructive" : undefined}>
          <AlertDescription>{msg.text}</AlertDescription>
        </Alert>
      ) : null}

      {loading ? (
        <LoadingRows rows={6} />
      ) : error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={History}
          title="No messages yet"
          description="WhatsApp notifications appear here as soon as orders change status (BOOKED, out for delivery, delivered, returned, shipper advise)."
        />
      ) : (
        <div className="space-y-3">
          {rows.map((m) => (
            <div key={m.id} className="rounded-xl border bg-card p-4">
              <div className="flex flex-wrap items-center gap-2">
                <WANotificationTypeBadge type={m.notification_type} />
                <WAMessageStatusBadge status={m.status} />
                <span className="text-sm font-medium">{m.order_number ?? "—"}</span>
                <span className="text-xs text-muted-foreground">
                  to {m.recipient_kind === "group" ? m.recipient : prettyPhone(m.recipient)} · {m.recipient_kind}
                </span>
                <span className="ml-auto text-xs text-muted-foreground">
                  created {formatDateTime(m.created_at)}
                  {m.sent_at ? ` · sent ${formatDateTime(m.sent_at)}` : ""}
                </span>
              </div>

              <p className="mt-2 line-clamp-2 whitespace-pre-line rounded-md bg-muted/50 p-2 text-sm">{m.message}</p>

              {m.failure_reason ? (
                <p className="mt-2 text-sm text-rose-600">
                  <span className="font-medium">Failure reason:</span> {m.failure_reason}
                  {m.retry_count > 0 ? <span className="ml-2 text-xs text-muted-foreground">(attempt {m.retry_count + 1}/{m.max_retries + 1})</span> : null}
                </p>
              ) : null}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {m.account_name ? `via ${m.account_name}` : "account selected at send time"}
                </span>
                <div className="ml-auto flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setDetails(m)}>
                    <ChevronDown className="mr-1 h-4 w-4" /> Details
                  </Button>
                  {m.status === "failed" ? (
                    <Button size="sm" disabled={busyId === m.id} onClick={() => act(m, "retry")}>
                      <RotateCcw className="mr-1 h-4 w-4" /> Retry
                    </Button>
                  ) : null}
                  {["pending", "retrying", "processing", "failed"].includes(m.status) ? (
                    <Button size="sm" variant="outline" disabled={busyId === m.id} onClick={() => act(m, "cancel")}>
                      <Ban className="mr-1 h-4 w-4" /> Cancel
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          ))}

          {totalPages > 1 ? (
            <div className="flex items-center justify-between pt-1">
              <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {page} of {totalPages} ({total} messages)
              </span>
              <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          ) : null}
        </div>
      )}

      <MessageDetailsDialog item={details} onClose={() => setDetails(null)} />
    </div>
  );
}

function MessageDetailsDialog({ item, onClose }: { item: WhatsAppQueueItem | null; onClose: () => void }) {
  const { data } = useList<WhatsAppMessageLog>(
    item ? `/api/whatsapp/logs?f_queue_id=${item.id}&perPage=50` : "/api/whatsapp/logs",
    [item?.id],
    { enabled: !!item }
  );

  return (
    <Dialog open={!!item} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Delivery attempts</DialogTitle>
          <DialogDescription>
            {item?.order_number ?? "—"} · {item?.notification_type.replace(/_/g, " ")} · {item?.status}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-80 space-y-2 overflow-y-auto">
          <p className="whitespace-pre-line rounded-md bg-muted/50 p-3 text-sm">{item?.message}</p>
          {(data?.rows ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No delivery attempts recorded yet.</p>
          ) : (
            (data?.rows ?? []).map((log) => (
              <div key={log.id} className="flex items-start gap-2 rounded-md border p-2 text-sm">
                <span className="font-medium">#{log.attempt}</span>
                <WAMessageStatusBadge status={log.status} />
                <span className="text-xs text-muted-foreground">{formatDateTime(log.created_at)}</span>
                {log.error ? <span className="ml-auto max-w-[60%] text-right text-xs text-rose-600">{log.error}</span> : null}
              </div>
            ))
          )}
          {item?.failure_reason ? (
            <p className="text-sm text-rose-600">
              <span className="font-medium">Last failure:</span> {item.failure_reason}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
