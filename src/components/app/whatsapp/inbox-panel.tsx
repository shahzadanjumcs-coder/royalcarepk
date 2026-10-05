"use client";

import { useState } from "react";
import { useList, useDebounced } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { LoadingRows, EmptyState } from "@/components/app/states";
import { formatDateTime, prettyPhone } from "./shared";
import type { WhatsAppInboxItem } from "@/lib/types";
import { Search, Inbox, ArrowDownLeft } from "lucide-react";

const KIND_BADGE: Record<string, string> = {
  direct: "border-sky-200 bg-sky-50 text-sky-700",
  group: "border-violet-200 bg-violet-50 text-violet-700",
  broadcast: "border-amber-200 bg-amber-50 text-amber-700",
};

/**
 * Incoming panel — WhatsApp messages RECEIVED by the bot's linked account.
 * Captured live by the local bot (Baileys messages.upsert) into the
 * whatsapp_inbox table: status broadcasts, the account's own outgoing
 * messages and protocol noise are excluded.
 */
export function WhatsAppInboxPanel() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebounced(search, 350);

  const query = new URLSearchParams({
    page: String(page),
    perPage: "15",
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
  }).toString();

  const { data, loading, error } = useList<WhatsAppInboxItem>(
    `/api/whatsapp/inbox?${query}`,
    [debouncedSearch, page]
  );

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / 15));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Sender / name / text…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <p className="ml-auto text-xs text-muted-foreground">
          Messages received by the connected WhatsApp account, captured live by the local bot.
        </p>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : loading ? (
        <LoadingRows rows={6} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No incoming messages yet"
          description="Messages sent to the connected WhatsApp number appear here in real time. If nothing shows up, check that the bot CMD window is running and the migration 0005 (whatsapp_inbox) has been applied in Supabase."
        />
      ) : (
        <div className="space-y-2">
          {rows.map((m) => (
            <div key={m.id} className="rounded-xl border bg-card p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 text-sm font-medium">
                  <ArrowDownLeft className="h-4 w-4 text-emerald-600" />
                  {m.sender_name ? `${m.sender_name} · ` : ""}
                  {m.chat_kind === "group" ? "group chat" : prettyPhone(m.sender_phone)}
                </span>
                <span
                  className={`rounded-full border px-2 py-0.5 text-xs ${KIND_BADGE[m.chat_kind] ?? "border-zinc-200 bg-zinc-100 text-zinc-600"}`}
                >
                  {m.chat_kind}
                </span>
                {m.message_type ? (
                  <span className="rounded-full border border-zinc-200 bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">
                    {m.message_type}
                  </span>
                ) : null}
                <span className="ml-auto text-xs text-muted-foreground">
                  {formatDateTime(m.wa_timestamp ?? m.created_at)}
                </span>
              </div>
              <p className="mt-2 whitespace-pre-line rounded-md bg-muted/50 p-2 text-sm">{m.body ?? ""}</p>
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
    </div>
  );
}
