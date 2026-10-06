"use client";

import { useState } from "react";
import { api, useList, ApiError } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Trash2, Users, Radio, Download } from "lucide-react";
import { prettyPhone } from "./shared";
import type { WhatsAppAdminRecipient, WhatsAppGroupSetting } from "@/lib/types";

/** Admin recipients + Flaship group configuration. */
export function WhatsAppRecipientsPanel() {
  return (
    <div className="space-y-6">
      <AdminRecipientsCard />
      <GroupsCard />
    </div>
  );
}

function AdminRecipientsCard() {
  const { data, refresh } = useList<WhatsAppAdminRecipient>("/api/whatsapp/recipients?perPage=100");
  const [label, setLabel] = useState("");
  const [phone, setPhone] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const rows = data?.rows ?? [];

  async function add() {
    setMsg(null);
    try {
      await api("/api/whatsapp/recipients", { method: "POST", json: { label, phone } });
      setLabel("");
      setPhone("");
      setMsg({ kind: "ok", text: "Admin recipient added." });
      refresh();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof ApiError ? e.message : "Could not add recipient." });
    }
  }

  async function toggle(r: WhatsAppAdminRecipient) {
    await api("/api/whatsapp/recipients", { method: "PATCH", json: { id: r.id, enabled: !r.enabled } });
    refresh();
  }

  async function remove(id: string) {
    await api(`/api/whatsapp/recipients?id=${id}`, { method: "DELETE" });
    refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="h-4 w-4" /> Admin Recipients
        </CardTitle>
        <CardDescription>RETURNED alerts go to every enabled admin number. Add as many as you need.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {msg ? (
          <Alert variant={msg.kind === "err" ? "destructive" : undefined}>
            <AlertDescription>{msg.text}</AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-2 sm:grid-cols-[180px_1fr_auto]">
          <Input placeholder="Label (e.g. Manager)" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
          <Input placeholder="03XX… / +92XX… / 92XX…" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <Button onClick={add} disabled={!phone.trim()}>
            Add Recipient
          </Button>
        </div>

        {rows.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            No admin recipients yet — RETURNED notifications will be logged as failed until one is added.
          </p>
        ) : (
          <div className="space-y-2">
            {rows.map((r) => (
              <div key={r.id} className="flex items-center gap-3 rounded-lg border p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{r.label}</p>
                  <p className="text-xs text-muted-foreground">{prettyPhone(r.phone)}</p>
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <Switch checked={r.enabled} onCheckedChange={() => toggle(r)} aria-label={`Toggle ${r.label}`} />
                  <Button size="icon" variant="outline" className="h-8 w-8 text-rose-600" onClick={() => remove(r.id)} aria-label={`Remove ${r.label}`}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface JoinedGroup {
  id: string;
  name: string;
}

function GroupsCard() {
  const { data: accountsData } = useList<{ id: string; name: string; status: string }>("/api/whatsapp/accounts");
  const { data, refresh } = useList<WhatsAppGroupSetting>("/api/whatsapp/groups?perPage=50");
  const [label, setLabel] = useState("");
  const [jid, setJid] = useState("");
  const [accountId, setAccountId] = useState("");
  const [fetching, setFetching] = useState(false);
  const [joined, setJoined] = useState<JoinedGroup[] | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const rows = data?.rows ?? [];
  const accounts = accountsData?.rows ?? [];
  const connectedAccounts = accounts.filter((a) => a.status === "connected");

  async function add() {
    setMsg(null);
    try {
      await api("/api/whatsapp/groups", {
        method: "POST",
        json: { label, group_jid: jid, account_id: accountId || null },
      });
      setLabel("");
      setJid("");
      setMsg({ kind: "ok", text: "Group saved. SHIPPER ADVISE messages will go here when enabled." });
      refresh();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof ApiError ? e.message : "Could not save the group." });
    }
  }

  async function fetchGroups() {
    if (!accountId) {
      setMsg({ kind: "err", text: "Select the connected WhatsApp account that is a member of the group first." });
      return;
    }
    setFetching(true);
    setMsg(null);
    try {
      const res = await api<{ command_id: string }>("/api/whatsapp/groups", {
        method: "POST",
        json: { action: "list_groups", account_id: accountId },
      });
      // poll the command result a few times
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const { command } = await api<{ command: { status: string; result: string | null } }>(
          `/api/whatsapp/commands/${res.command_id}`
        );
        if (command.status === "done" && command.result) {
          try {
            const parsed = JSON.parse(command.result) as JoinedGroup[];
            setJoined(parsed);
            setMsg({ kind: "ok", text: `Found ${parsed.length} group(s) — press “use” to fill the identifier.` });
          } catch {
            setMsg({ kind: "err", text: "Bot returned an unreadable group list." });
          }
          break;
        }
        if (command.status === "failed") {
          setMsg({ kind: "err", text: command.result ?? "The bot could not list groups." });
          break;
        }
      }
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof ApiError ? e.message : "Could not reach the bot." });
    } finally {
      setFetching(false);
    }
  }

  async function toggle(g: WhatsAppGroupSetting) {
    await api("/api/whatsapp/groups", { method: "PATCH", json: { id: g.id, enabled: !g.enabled } });
    refresh();
  }

  async function remove(id: string) {
    await api(`/api/whatsapp/groups?id=${id}`, { method: "DELETE" });
    refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Radio className="h-4 w-4" /> Flaship WhatsApp Group
        </CardTitle>
        <CardDescription>
          SHIPPER ADVISE updates go here — never to random groups. Add the bot account to the WhatsApp group, fetch the
          group list, then enable it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {msg ? (
          <Alert variant={msg.kind === "err" ? "destructive" : undefined}>
            <AlertDescription>{msg.text}</AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-2 sm:grid-cols-[160px_1fr_170px_auto]">
          <Input placeholder="Label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
          <Input
            placeholder="Group JID (120363…-…@g.us)"
            value={jid}
            onChange={(e) => setJid(e.target.value)}
          />
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            aria-label="Sending account for this group"
          >
            <option value="">Sending account…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} {a.status === "connected" ? "●" : "○"}
              </option>
            ))}
          </select>
          <Button onClick={add} disabled={!jid.trim()}>
            Add Group
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={fetchGroups} disabled={fetching || connectedAccounts.length === 0}>
            <Download className="mr-2 h-4 w-4" />
            {fetching ? "Asking the bot…" : "Fetch groups from bot"}
          </Button>
          {connectedAccounts.length === 0 ? (
            <span className="text-xs text-muted-foreground">Connect a WhatsApp account that is a member of the group first.</span>
          ) : null}
        </div>

        {joined && joined.length > 0 ? (
          <div className="max-h-48 space-y-2 overflow-y-auto rounded-lg border p-2">
            {joined.map((g) => (
              <div key={g.id} className="flex items-center gap-2 text-sm">
                <span className="font-medium">{g.name || "Unnamed group"}</span>
                <code className="truncate text-xs text-muted-foreground">{g.id}</code>
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto h-7"
                  onClick={() => {
                    setJid(g.id);
                    if (!label) setLabel(g.name || "Flaship Group");
                  }}
                >
                  use
                </Button>
              </div>
            ))}
          </div>
        ) : null}

        {rows.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            No group configured — SHIPPER ADVISE notifications will be logged as failed until a group is added.
          </p>
        ) : (
          <div className="space-y-2">
            {rows.map((g) => {
              const acc = accounts.find((a) => a.id === g.account_id);
              return (
                <div key={g.id} className="flex items-center gap-3 rounded-lg border p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{g.label}</p>
                    <p className="truncate text-xs text-muted-foreground">{g.group_jid}</p>
                  </div>
                  <span className="ml-auto text-xs text-muted-foreground">via {acc?.name ?? "default account"}</span>
                  <Switch checked={g.enabled} onCheckedChange={() => toggle(g)} aria-label={`Toggle ${g.label}`} />
                  <Button size="icon" variant="outline" className="h-8 w-8 text-rose-600" onClick={() => remove(g.id)} aria-label={`Remove ${g.label}`}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
