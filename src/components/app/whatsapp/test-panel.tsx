"use client";

import { useEffect, useRef, useState } from "react";
import { api, useList, ApiError } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Send } from "lucide-react";
import type { WhatsAppCommand } from "@/lib/types";

/** Test message panel — clearly-labelled test sends to a phone or the Flaship group. */
export function WhatsAppTestPanel() {
  const { data } = useList<{ id: string; name: string; status: string }>("/api/whatsapp/accounts");
  const [kind, setKind] = useState<"message" | "group">("message");
  const [accountId, setAccountId] = useState("");
  const [phone, setPhone] = useState("");
  const [groupJid, setGroupJid] = useState("");
  const [text, setText] = useState("RoyalCarePK test message — please ignore.");
  const [sending, setSending] = useState(false);
  const [commandId, setCommandId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const accounts = data?.rows ?? [];

  useEffect(() => {
    if (!commandId) return;
    let tries = 0;
    pollRef.current = setInterval(async () => {
      tries++;
      try {
        const { command } = await api<{ command: WhatsAppCommand }>(`/api/whatsapp/commands/${commandId}`);
        if (command.status === "done") {
          setMsg({ kind: "ok", text: `Test delivered. ${command.result ?? ""}` });
          setCommandId(null);
          if (pollRef.current) clearInterval(pollRef.current);
        } else if (command.status === "failed") {
          setMsg({ kind: "err", text: command.result ?? "The bot reported a failure." });
          setCommandId(null);
          if (pollRef.current) clearInterval(pollRef.current);
        } else if (tries > 20) {
          setMsg({ kind: "err", text: "No result from the bot — is it running?" });
          setCommandId(null);
          if (pollRef.current) clearInterval(pollRef.current);
        }
      } catch {
        /* keep polling */
      }
    }, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [commandId]);

  async function send() {
    setSending(true);
    setMsg(null);
    try {
      const res = await api<{ command_id: string; message: string }>("/api/whatsapp/test", {
        method: "POST",
        json:
          kind === "message"
            ? { kind, account_id: accountId, phone, message: text }
            : { kind, account_id: accountId, group_jid: groupJid, message: text },
      });
      setCommandId(res.command_id);
      setMsg({ kind: "ok", text: res.message });
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof ApiError ? e.message : "Could not queue the test." });
    } finally {
      setSending(false);
    }
  }

  const selected = accounts.find((a) => a.id === accountId);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Send a test message</CardTitle>
        <CardDescription>
          Test sends are always labelled with a visible <code className="rounded bg-muted px-1">[RoyalCarePK TEST]</code> prefix,
          so they can never be mistaken for real order notifications.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant={kind === "message" ? "default" : "outline"} onClick={() => setKind("message")}>
            Test phone number
          </Button>
          <Button size="sm" variant={kind === "group" ? "default" : "outline"} onClick={() => setKind("group")}>
            Test Flaship group
          </Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label className="text-xs text-muted-foreground">WhatsApp account</Label>
            <select
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              <option value="">Select account…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id} disabled={a.status !== "connected"}>
                  {a.name} {a.status === "connected" ? "(connected)" : "(not connected)"}
                </option>
              ))}
            </select>
          </div>
          {kind === "message" ? (
            <div>
              <Label className="text-xs text-muted-foreground">Test phone number</Label>
              <Input
                className="mt-1"
                placeholder="03XX… / +92XX… / 92XX…"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
          ) : (
            <div>
              <Label className="text-xs text-muted-foreground">Group JID (from Recipients &amp; Groups tab)</Label>
              <Input
                className="mt-1"
                placeholder="120363…-…@g.us"
                value={groupJid}
                onChange={(e) => setGroupJid(e.target.value)}
              />
            </div>
          )}
        </div>

        <div>
          <Label className="text-xs text-muted-foreground">Test message</Label>
          <Textarea className="mt-1 min-h-20" value={text} onChange={(e) => setText(e.target.value)} maxLength={3000} />
        </div>

        {msg ? (
          <Alert variant={msg.kind === "err" ? "destructive" : undefined}>
            <AlertDescription>{msg.text}</AlertDescription>
          </Alert>
        ) : null}

        <Button onClick={send} disabled={sending || !accountId || (kind === "message" ? !phone.trim() : !groupJid.trim())}>
          <Send className="mr-2 h-4 w-4" /> {sending ? "Queueing…" : "Send Test"}
        </Button>
        {selected && selected.status !== "connected" ? (
          <p className="text-xs text-rose-600">“{selected.name}” is not connected — connect it first.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
