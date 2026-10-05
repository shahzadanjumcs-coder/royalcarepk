"use client";

import { useEffect, useState } from "react";
import { api, useApi, ApiError } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Pause, Play, Save, ShieldAlert } from "lucide-react";
import { WANotificationTypeBadge } from "./shared";
import {
  WHATSAPP_NOTIFICATION_TYPES,
  WHATSAPP_TYPE_LABELS,
  type WhatsAppAccount,
  type WhatsAppBotSettings,
  type WhatsAppRoutingSetting,
} from "@/lib/types";

interface SettingsResponse {
  routing: WhatsAppRoutingSetting[];
  bot: WhatsAppBotSettings | null;
  accounts: WhatsAppAccount[];
}

/**
 * Routing & Templates panel — choose which WhatsApp number handles each
 * notification type, edit templates ({{safe_var}} only), configure failover,
 * rate-limit delay, retry cap and pause/resume the bot.
 */
export function WhatsAppRoutingPanel() {
  const { data, loading, error, refresh } = useApi<SettingsResponse>("/api/whatsapp/settings");
  const [routing, setRouting] = useState<WhatsAppRoutingSetting[]>([]);
  const [bot, setBot] = useState<Partial<WhatsAppBotSettings>>({});
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) {
      setRouting(data.routing);
      if (data.bot) setBot(data.bot);
    }
  }, [data]);

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      await api("/api/whatsapp/settings", {
        method: "PATCH",
        json: {
          routing: routing.map((r) => ({
            notification_type: r.notification_type,
            account_id: r.account_id,
            fallback_account_id: r.fallback_account_id,
            enabled: r.enabled,
            template: r.template,
          })),
          bot: {
            failover_enabled: bot.failover_enabled,
            send_delay_ms: bot.send_delay_ms,
            max_retries: bot.max_retries,
          },
        },
      });
      setMsg({ kind: "ok", text: "Routing and templates saved." });
      refresh();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof ApiError ? e.message : "Could not save settings." });
    } finally {
      setSaving(false);
    }
  }

  async function setPaused(paused: boolean) {
    setMsg(null);
    try {
      await api("/api/whatsapp/settings", { method: "PATCH", json: { bot: { paused } } });
      setBot((b) => ({ ...b, paused }));
      setMsg({ kind: "ok", text: paused ? "Bot paused — queued messages stay stored and wait." : "Bot resumed — the queue continues processing." });
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof ApiError ? e.message : "Could not change bot state." });
    }
  }

  function patchRouting(type: string, patch: Partial<WhatsAppRoutingSetting>) {
    setRouting((rows) => rows.map((r) => (r.notification_type === type ? { ...r, ...patch } : r)));
  }

  if (loading) return <div className="py-10 text-center text-sm text-muted-foreground">Loading settings…</div>;
  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;

  const accounts = data?.accounts ?? [];
  const connected = accounts.filter((a) => a.status === "connected" && a.enabled);

  return (
    <div className="space-y-6">
      {/* Bot controls */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bot state & safety</CardTitle>
          <CardDescription>Pause stops all outgoing WhatsApp messages. Queued messages remain stored and resume on Play.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            {bot.paused ? (
              <Button onClick={() => setPaused(false)}>
                <Play className="mr-2 h-4 w-4" /> Resume Bot
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setPaused(true)}>
                <Pause className="mr-2 h-4 w-4" /> Pause Bot
              </Button>
            )}
            <span className="text-sm text-muted-foreground">{bot.paused ? "Bot is PAUSED." : "Bot is active."}</span>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div>
                <Label htmlFor="wa-failover" className="text-sm font-medium">Account failover</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">Use the fallback number if the primary is offline.</p>
              </div>
              <Switch
                id="wa-failover"
                checked={!!bot.failover_enabled}
                onCheckedChange={(v) => setBot((b) => ({ ...b, failover_enabled: v }))}
              />
            </div>
            <div className="rounded-lg border p-3">
              <Label htmlFor="wa-delay" className="text-sm font-medium">Delay between sends (ms)</Label>
              <Input
                id="wa-delay"
                type="number"
                min={500}
                max={60000}
                step={250}
                className="mt-1"
                value={bot.send_delay_ms ?? 2500}
                onChange={(e) => setBot((b) => ({ ...b, send_delay_ms: Number(e.target.value) }))}
              />
            </div>
            <div className="rounded-lg border p-3">
              <Label htmlFor="wa-retries" className="text-sm font-medium">Max retries</Label>
              <Input
                id="wa-retries"
                type="number"
                min={0}
                max={10}
                className="mt-1"
                value={bot.max_retries ?? 3}
                onChange={(e) => setBot((b) => ({ ...b, max_retries: Number(e.target.value) }))}
              />
            </div>
          </div>

          <Alert>
            <ShieldAlert className="h-4 w-4" />
            <AlertDescription>
              This is an unofficial WhatsApp Web automation. Rate limits are deliberately conservative (sequential sends +
              delay). Accounts can still be restricted by WhatsApp if used improperly — keep it to transactional notifications.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {/* Routing matrix + templates */}
      <Card>
        <CardHeader className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-base">Message routing & templates</CardTitle>
            <CardDescription>
              Which number sends which notification. {connected.length === 0 ? "No connected accounts yet — routing can still be prepared." : ""}
            </CardDescription>
          </div>
          <Button onClick={save} disabled={saving}>
            <Save className="mr-2 h-4 w-4" /> {saving ? "Saving…" : "Save Changes"}
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {msg ? (
            <Alert variant={msg.kind === "err" ? "destructive" : undefined}>
              <AlertDescription>{msg.text}</AlertDescription>
            </Alert>
          ) : null}

          {routing.map((r) => (
            <div key={r.notification_type} className="rounded-xl border p-4">
              <div className="flex flex-wrap items-center gap-3">
                <WANotificationTypeBadge type={r.notification_type} />
                <span className="text-sm font-medium">{WHATSAPP_TYPE_LABELS[r.notification_type]}</span>
                <span className="text-xs text-muted-foreground">
                  sends to {r.notification_type === "RETURNED" ? "admin recipients" : r.notification_type === "SHIPPER_ADVISE" ? "Flaship group(s)" : "customer"}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  <Label htmlFor={`en-${r.notification_type}`} className="text-xs text-muted-foreground">
                    {r.enabled ? "Enabled" : "Disabled"}
                  </Label>
                  <Switch
                    id={`en-${r.notification_type}`}
                    checked={r.enabled}
                    onCheckedChange={(v) => patchRouting(r.notification_type, { enabled: v })}
                  />
                </div>
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <Label className="text-xs text-muted-foreground">Sending account</Label>
                  <select
                    className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={r.account_id ?? ""}
                    onChange={(e) => patchRouting(r.notification_type, { account_id: e.target.value || null })}
                  >
                    <option value="">Default account</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} {a.status === "connected" ? "●" : "○"}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Fallback account (failover)</Label>
                  <select
                    className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={r.fallback_account_id ?? ""}
                    onChange={(e) => patchRouting(r.notification_type, { fallback_account_id: e.target.value || null })}
                  >
                    <option value="">No fallback</option>
                    {accounts
                      .filter((a) => a.id !== r.account_id)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name} {a.status === "connected" ? "●" : "○"}
                        </option>
                      ))}
                  </select>
                </div>
              </div>

              <div className="mt-3">
                <Label className="text-xs text-muted-foreground">
                  Template — safe variables: {"{{customer_name}} {{order_number}} {{cn_number}} {{courier}} {{status}} {{return_reason}} {{reason}}"}
                </Label>
                <Textarea
                  className="mt-1 min-h-24 font-mono text-xs"
                  value={r.template}
                  onChange={(e) => patchRouting(r.notification_type, { template: e.target.value })}
                  spellCheck={false}
                />
              </div>
            </div>
          ))}

          <p className="text-xs text-muted-foreground">
            {WHATSAPP_NOTIFICATION_TYPES.length} notification types · templates render on the server with plain-text
            substitution only — no code in templates can execute.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
