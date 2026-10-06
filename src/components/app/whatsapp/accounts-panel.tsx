"use client";

import { useEffect, useState } from "react";
import { api, useList, ApiError } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { EmptyState, LoadingRows } from "@/components/app/states";
import { WAConnectionBadge, timeAgo, prettyPhone } from "./shared";
import type { WhatsAppAccount } from "@/lib/types";
import { Plus, QrCode, RefreshCw, LogOut, Trash2, Star, Power, MessageCircle } from "lucide-react";

/**
 * WhatsApp Accounts panel — add multiple numbers, pair via QR, reconnect,
 * logout, enable/disable, set default, remove. Every account's session is
 * isolated on the bot host; disconnecting one never touches another.
 */
export function WhatsAppAccountsPanel() {
  const { data, loading, error, refresh } = useList<WhatsAppAccount>("/api/whatsapp/accounts");
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<WhatsAppAccount | null>(null);
  const [qrAccount, setQrAccount] = useState<WhatsAppAccount | null>(null);

  const accounts = data?.rows ?? [];
  /** A session only counts as usable when the bot heartbeat is fresh (session_live). */
  const isLive = (a: WhatsAppAccount) => a.session_live === true;
  const anyConnecting = accounts.some((a) => a.status === "connecting");

  // poll faster while a QR pairing is in progress so the QR appears promptly
  useEffect(() => {
    if (!anyConnecting) return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [anyConnecting, refresh]);

  // keep the QR dialog live while it is open
  useEffect(() => {
    if (!qrAccount) return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [qrAccount, refresh]);

  const liveQr = qrAccount ? accounts.find((a) => a.id === qrAccount.id) ?? qrAccount : null;

  async function addAccount() {
    if (!name.trim()) return;
    setMsg(null);
    try {
      await api("/api/whatsapp/accounts", { method: "POST", json: { name: name.trim() } });
      setAddOpen(false);
      setName("");
      setMsg({ kind: "ok", text: "Account added. Press Connect and scan the QR with that phone." });
      refresh();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof ApiError ? e.message : "Could not add the account." });
    }
  }

  async function action(account: WhatsAppAccount, act: string, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusyId(account.id);
    setMsg(null);
    try {
      const res = await api<{ message?: string }>(`/api/whatsapp/accounts/${account.id}`, {
        method: "POST",
        json: { action: act },
      });
      if (act === "connect") setQrAccount(account);
      setMsg({ kind: "ok", text: res.message ?? "Done." });
      refresh();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof ApiError ? e.message : "Action failed." });
    } finally {
      setBusyId(null);
    }
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    await action(removeTarget, "remove");
    setRemoveTarget(null);
    if (qrAccount?.id === removeTarget.id) setQrAccount(null);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm text-muted-foreground">
          Har WhatsApp number ka apna isolated persistent session hota hai — ek number connect/disconnect karne se doosra number kabhi affected nahi hota.
        </div>
        <Button onClick={() => setAddOpen(true)} className="shrink-0">
          <Plus className="mr-2 h-4 w-4" /> Add WhatsApp Number
        </Button>
      </div>

      {msg ? (
        <Alert variant={msg.kind === "err" ? "destructive" : undefined}>
          <AlertDescription>{msg.text}</AlertDescription>
        </Alert>
      ) : null}

      {loading ? (
        <LoadingRows rows={3} />
      ) : error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : accounts.length === 0 ? (
        <EmptyState
          icon={MessageCircle}
          title="No WhatsApp numbers yet"
          description="Add your first WhatsApp number, press Connect, then scan the QR code from that phone's WhatsApp (Linked devices)."
          action={
            <Button onClick={() => setAddOpen(true)}>
              <Plus className="mr-2 h-4 w-4" /> Add WhatsApp Number
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {accounts.map((a) => (
            <Card key={a.id} className="flex flex-col">
              <CardContent className="flex flex-1 flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate font-medium">{a.name}</p>
                      {a.is_default ? (
                        <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                          Default
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-sm text-muted-foreground">{prettyPhone(a.phone)}</p>
                  </div>
                  <WAConnectionBadge status={a.status} live={a.session_live} />
                </div>

                {a.status === "connected" && !isLive(a) ? (
                  <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-700">
                    The database shows connected, but the bot has not reported this session recently — the bot process is
                    likely down. Start the bot, then press Reconnect if it does not recover on its own.
                  </p>
                ) : null}

                <div className="space-y-1 text-xs text-muted-foreground">
                  <p>
                    <Power className="mr-1 inline h-3 w-3" />
                    {a.enabled ? "Enabled" : "Disabled"} · seen {timeAgo(a.last_seen_at)}
                  </p>
                  <p>Last connected: {timeAgo(a.last_connected_at)}</p>
                  {a.last_error ? <p className="text-rose-600">Last error: {a.last_error}</p> : null}
                </div>

                {a.status === "connecting" && a.qr_code ? (
                  <Button variant="outline" size="sm" onClick={() => setQrAccount(a)}>
                    <QrCode className="mr-2 h-4 w-4" /> Show QR Code
                  </Button>
                ) : null}

                <div className="mt-auto flex flex-wrap gap-2 pt-1">
                  {!isLive(a) ? (
                    <Button
                      size="sm"
                      variant={a.status === "disconnected" ? "default" : "outline"}
                      disabled={busyId === a.id || !a.enabled}
                      onClick={() => action(a, "connect")}
                    >
                      <QrCode className="mr-2 h-4 w-4" />
                      {a.status === "connecting" ? "Waiting for scan…" : "Connect"}
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" disabled={busyId === a.id} onClick={() => action(a, "connect")}>
                      <RefreshCw className="mr-2 h-4 w-4" /> Reconnect
                    </Button>
                  )}
                  {isLive(a) ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId === a.id}
                      onClick={() => action(a, "logout", `Logout "${a.name}" from WhatsApp? A new QR scan will be needed to reconnect.`)}
                    >
                      <LogOut className="mr-2 h-4 w-4" /> Logout
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyId === a.id}
                    onClick={() => action(a, a.enabled ? "disable" : "enable")}
                  >
                    <Power className="mr-2 h-4 w-4" /> {a.enabled ? "Disable" : "Enable"}
                  </Button>
                  {!a.is_default ? (
                    <Button size="sm" variant="outline" disabled={busyId === a.id} onClick={() => action(a, "set_default")}>
                      <Star className="mr-2 h-4 w-4" /> Set Default
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-rose-600 hover:text-rose-700"
                    disabled={busyId === a.id}
                    onClick={() => setRemoveTarget(a)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" /> Remove
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Add account dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add WhatsApp Number</DialogTitle>
            <DialogDescription>
              Give this number a recognisable name (e.g. “Main WhatsApp”, “Office WhatsApp”). The phone number itself is
              detected automatically after the QR scan.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="wa-name">Account name</Label>
            <Input id="wa-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Main WhatsApp" maxLength={60} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button onClick={addAccount} disabled={!name.trim()}>
              Add Account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* QR pairing dialog */}
      <Dialog open={!!liveQr} onOpenChange={(open) => !open && setQrAccount(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Pair {liveQr?.name}</DialogTitle>
            <DialogDescription>
              On that phone open WhatsApp → Settings → Linked devices → Link a device, then scan this QR. The QR refreshes
              automatically — keep this dialog open.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3 py-2">
            {liveQr?.qr_code ? (
              <img src={liveQr.qr_code} alt="WhatsApp pairing QR code" className="h-64 w-64 rounded-lg border bg-white p-2" />
            ) : (
              <div className="flex h-64 w-64 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-center text-sm text-muted-foreground">
                <RefreshCw className="h-6 w-6 animate-spin" />
                Waiting for the bot to produce a QR code…
                <span className="text-xs">Is the bot service running on your always-on machine?</span>
              </div>
            )}
            <p className="text-center text-xs text-muted-foreground">
              Status: {liveQr?.status ?? "connecting"} · updated {timeAgo(liveQr?.qr_updated_at)}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setQrAccount(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove confirmation */}
      <AlertDialog open={!!removeTarget} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removeTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The account is deleted from RoyalCarePK and the bot wipes its isolated session files. Queued messages are not
              deleted. To use this number again you must add it and scan a new QR.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-rose-600 hover:bg-rose-700" onClick={confirmRemove}>
              Remove Account
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
