"use client";

import { useEffect, useState } from "react";
import { api, useApi } from "@/lib/client";
import { PageHeader } from "@/components/app/states";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Pause, Play, Wifi, WifiOff } from "lucide-react";
import { WhatsAppAccountsPanel } from "@/components/app/whatsapp/accounts-panel";
import { WhatsAppMessagesPanel } from "@/components/app/whatsapp/messages-panel";
import { WhatsAppRoutingPanel } from "@/components/app/whatsapp/routing-panel";
import { WhatsAppRecipientsPanel } from "@/components/app/whatsapp/recipients-panel";
import { WhatsAppTestPanel } from "@/components/app/whatsapp/test-panel";
import { timeAgo } from "@/components/app/whatsapp/shared";

interface Overview {
  accounts: { total: number; connected: number; connecting: number; enabled: number };
  counts: { pending: number; processing: number; retrying: number; failed: number; sent: number; cancelled: number };
  paused: boolean;
  failover_enabled: boolean;
  bot_online: boolean;
  bot_last_seen_at: string | null;
  last_failure: { order_number: string | null; type: string; reason: string } | null;
}

/**
 * WhatsApp Bot admin console — accounts, message logs, routing/templates,
 * recipients & groups, test sends. The bot itself runs as a separate service;
 * this page stays fully functional (and the app unaffected) while it is offline.
 */
export default function WhatsAppAdminPage() {
  const { data, refresh } = useApi<Overview>("/api/whatsapp/overview", [], { enabled: true });
  const [tick, setTick] = useState(0);

  // refresh the summary periodically (same polling model as the notification bell)
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 10000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (tick > 0) refresh();
  }, [tick, refresh]);

  async function togglePaused() {
    if (!data) return;
    await api("/api/whatsapp/settings", { method: "PATCH", json: { bot: { paused: !data.paused } } });
    refresh();
  }

  const counts = data?.counts;

  return (
    <div className="space-y-6">
      <PageHeader
        title="WhatsApp Bot"
        description="Multi-account WhatsApp Web automation for order notifications. Sessions live on the bot machine — the app keeps working even when the bot is offline."
        actions={
          data ? (
            <Button variant={data.paused ? "default" : "outline"} onClick={togglePaused}>
              {data.paused ? <Play className="mr-2 h-4 w-4" /> : <Pause className="mr-2 h-4 w-4" />}
              {data.paused ? "Resume Bot" : "Pause Bot"}
            </Button>
          ) : null
        }
      />

      {/* Status strip */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={data?.bot_online ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-zinc-200 bg-zinc-100 text-zinc-500"}>
          {data?.bot_online ? <Wifi className="mr-1 h-3 w-3" /> : <WifiOff className="mr-1 h-3 w-3" />}
          {data?.bot_online ? "Bot online" : data?.bot_last_seen_at ? `Bot offline (seen ${timeAgo(data.bot_last_seen_at)})` : "Bot offline"}
        </Badge>
        <Badge variant="outline" className="border-sky-200 bg-sky-50 text-sky-700">
          {data?.accounts.connected ?? 0}/{data?.accounts.total ?? 0} connected
        </Badge>
        {data?.paused ? <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">PAUSED</Badge> : null}
        {counts ? (
          <>
            <Badge variant="outline">{counts.pending + counts.retrying} queued</Badge>
            <Badge variant="outline" className={counts.failed > 0 ? "border-rose-200 bg-rose-50 text-rose-700" : ""}>
              {counts.failed} failed
            </Badge>
            <Badge variant="outline">{counts.sent} sent</Badge>
          </>
        ) : null}
        {data?.failover_enabled ? <Badge variant="outline" className="border-violet-200 bg-violet-50 text-violet-700">Failover on</Badge> : null}
      </div>

      {data?.last_failure ? (
        <Alert variant="destructive">
          <AlertDescription>
            Latest failure — {data.last_failure.order_number ?? "order"} {data.last_failure.type.replace(/_/g, " ")}: {data.last_failure.reason}
          </AlertDescription>
        </Alert>
      ) : null}

      <Tabs defaultValue="accounts" className="space-y-4">
        <TabsList className="flex h-auto w-full flex-wrap justify-start">
          <TabsTrigger value="accounts">Accounts</TabsTrigger>
          <TabsTrigger value="messages">Message Logs</TabsTrigger>
          <TabsTrigger value="routing">Routing &amp; Templates</TabsTrigger>
          <TabsTrigger value="recipients">Recipients &amp; Groups</TabsTrigger>
          <TabsTrigger value="test">Test</TabsTrigger>
        </TabsList>
        <TabsContent value="accounts">
          <WhatsAppAccountsPanel />
        </TabsContent>
        <TabsContent value="messages">
          <WhatsAppMessagesPanel />
        </TabsContent>
        <TabsContent value="routing">
          <WhatsAppRoutingPanel />
        </TabsContent>
        <TabsContent value="recipients">
          <WhatsAppRecipientsPanel />
        </TabsContent>
        <TabsContent value="test">
          <WhatsAppTestPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
