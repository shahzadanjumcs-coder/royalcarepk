"use client";

import { Suspense, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useApi, useList, api, buildQuery, useDebounced } from "@/lib/client";
import { PageHeader } from "@/components/app/states";
import { DataTable, type Column } from "@/components/app/data-table";
import { FormDialog } from "@/components/app/form-dialog";
import { UserStatusBadge } from "@/components/app/badges";
import { BrandLogo } from "@/components/app/brand-logo";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ROLE_LABELS, type Role } from "@/lib/types";
import type { BrandingConfig } from "@/lib/branding-shared";
import { formatDateTime } from "@/lib/utils";
import { ImageIcon, Loader2, PlugZap, Plus, RefreshCw, RotateCcw, Save, ShieldCheck, Trash2, Upload } from "lucide-react";

interface UserRow {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: Role;
  worker_code: string | null;
  team_name: string | null;
  status: string;
  created_at: string;
}

interface RuleRow {
  id: string;
  name: string;
  scope: "default" | "worker";
  worker_id: string | null;
  worker_name: string | null;
  rate: number;
  status: string;
  note: string | null;
  created_at: string;
}

interface SettingsData {
  settings: {
    general?: { business_name?: string; phone?: string; address?: string; currency?: string; low_stock_threshold?: number };
    flaship?: {
      mode: string; base_url: string; api_key_set: boolean; api_key_masked?: string | null; api_key_source?: string | null;
      timeout_ms: number; endpoints: Record<string, string>;
      default_courier?: string | null; default_service_type?: string | null; default_pickup?: string | null; default_weight?: number;
    };
    commission?: { default_rate?: number; deduct_on_return?: boolean; pay_on_delivery_only?: boolean };
  };
}

const PERMISSIONS_MATRIX: { area: string; super_admin: string; admin: string; inventory_manager: string; worker: string }[] = [
  { area: "Orders & bookings", super_admin: "Full", admin: "Full", inventory_manager: "Read", worker: "Own orders" },
  { area: "Status changes", super_admin: "Full", admin: "Full", inventory_manager: "—", worker: "Transit → Delivered/Returned" },
  { area: "Customers", super_admin: "Full", admin: "Full", inventory_manager: "—", worker: "—" },
  { area: "Workers & teams", super_admin: "Full", admin: "Full", inventory_manager: "Read", worker: "—" },
  { area: "Commission ledger", super_admin: "Full", admin: "Full + manual adjustments", inventory_manager: "—", worker: "Own only" },
  { area: "Worker payments", super_admin: "Full", admin: "Full", inventory_manager: "—", worker: "Own only" },
  { area: "Inventory", super_admin: "Full", admin: "Full", inventory_manager: "Full", worker: "Read" },
  { area: "Flaship config & logs", super_admin: "Full", admin: "Full", inventory_manager: "—", worker: "—" },
  { area: "Branding", super_admin: "Full", admin: "Full", inventory_manager: "—", worker: "Read only" },
  { area: "Reports", super_admin: "Full", admin: "Full", inventory_manager: "—", worker: "—" },
  { area: "User management", super_admin: "Full", admin: "Workers only", inventory_manager: "—", worker: "—" },
  { area: "Roles & settings", super_admin: "Full", admin: "Read", inventory_manager: "Read", worker: "—" },
  { area: "Audit logs", super_admin: "Full", admin: "Full", inventory_manager: "—", worker: "—" },
];

function SettingsContent() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = params.get("tab") ?? "branding";
  const [userOpen, setUserOpen] = useState(false);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [userSearch, setUserSearch] = useState("");
  const debouncedUserSearch = useDebounced(userSearch);
  const [savingGeneral, setSavingGeneral] = useState(false);
  const [savingFlaship, setSavingFlaship] = useState(false);
  const [flashipKey, setFlashipKey] = useState("");
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const { data: settingsData, refresh: refreshSettings } = useApi<SettingsData>("/api/settings");
  const { data: brandingData, refresh: refreshBranding } = useApi<{ branding: BrandingConfig }>("/api/branding");
  const { data: users, loading: usersLoading, error: usersError, refresh: refreshUsers } = useList<UserRow>(
    `/api/users${buildQuery({ search: debouncedUserSearch, perPage: 20 })}`,
    [debouncedUserSearch]
  );
  const { data: rules, refresh: refreshRules } = useList<RuleRow>("/api/commission/rules");
  const { data: workers } = useApi<{ rows: { id: string; name: string; commission_rate: number }[] }>("/api/workers?perPage=100");

  const general = settingsData?.settings.general ?? {};
  const flaship = settingsData?.settings.flaship;
  const commission = settingsData?.settings.commission ?? {};
  const branding = brandingData?.branding;

  const userColumns: Column<UserRow>[] = [
    {
      key: "name",
      header: "User",
      render: (u) => (
        <div>
          <p className="font-medium">{u.name}</p>
          <p className="text-xs text-muted-foreground">{u.email}</p>
        </div>
      ),
    },
    {
      key: "role",
      header: "Role",
      render: (u) => (
        <select
          className="rounded-md border border-border bg-card px-2 py-1 text-xs"
          value={u.role}
          disabled={u.role === "super_admin"}
          onChange={async (e) => {
            await api(`/api/users/${u.id}`, { method: "PATCH", json: { role: e.target.value } });
            refreshUsers();
          }}
        >
          {Object.entries(ROLE_LABELS).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      ),
    },
    { key: "worker_code", header: "Worker ID", render: (u) => u.worker_code ?? "—", hideInCard: true },
    { key: "team_name", header: "Team", render: (u) => u.team_name ?? "—", hideInCard: true },
    { key: "status", header: "Status", render: (u) => <UserStatusBadge status={u.status} /> },
    { key: "created_at", header: "Joined", render: (u) => formatDateTime(u.created_at), hideInCard: true },
    {
      key: "actions",
      header: "",
      render: (u) => (
        <Button
          size="sm"
          variant={u.status === "active" ? "outline" : "default"}
          className={u.status === "active" ? "border-rose-200 text-rose-700 hover:bg-rose-50" : ""}
          disabled={u.role === "super_admin"}
          onClick={async () => {
            await api(`/api/users/${u.id}`, { method: "PATCH", json: { status: u.status === "active" ? "disabled" : "active" } });
            refreshUsers();
          }}
        >
          {u.status === "active" ? "Disable" : "Enable"}
        </Button>
      ),
    },
  ];

  const ruleColumns: Column<RuleRow>[] = [
    { key: "name", header: "Rule", render: (r) => <span className="font-medium">{r.name}</span> },
    { key: "worker_name", header: "Applies to", render: (r) => (r.scope === "default" ? <Badge variant="outline">All workers (default)</Badge> : r.worker_name ?? "—") },
    { key: "rate", header: "Rate", render: (r) => <span className="font-semibold">{r.rate}%</span> },
    { key: "note", header: "Note", render: (r) => r.note ?? "—", hideInCard: true },
    {
      key: "actions",
      header: "",
      render: (r) => (
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" onClick={async () => {
            const rate = window.prompt(`New rate for ${r.name} (%)`, String(r.rate));
            if (rate === null) return;
            await api(`/api/commission/rules/${r.id}`, { method: "PATCH", json: { rate: Number(rate) } });
            refreshRules();
          }}>Edit rate</Button>
          <Button size="sm" variant="outline" className="border-rose-200 text-rose-700 hover:bg-rose-50" onClick={async () => {
            if (!window.confirm("Delete this rule?")) return;
            await api(`/api/commission/rules/${r.id}`, { method: "DELETE" });
            refreshRules();
          }}>Delete</Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Settings" description="Branding, users, roles, commission rules, Flaship API and business preferences" />

      <Tabs value={tab} onValueChange={(v) => router.replace(`/admin/settings?tab=${v}`)}>
        <TabsList className="flex w-full flex-wrap justify-start gap-1 overflow-x-auto bg-muted/60 h-auto p-1">
          <TabsTrigger value="branding">Branding</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="roles">Roles &amp; Permissions</TabsTrigger>
          <TabsTrigger value="commission">Commission Rules</TabsTrigger>
          <TabsTrigger value="flaship">Flaship API</TabsTrigger>
          <TabsTrigger value="general">General</TabsTrigger>
        </TabsList>

        {/* BRANDING */}
        <TabsContent value="branding" className="mt-4">
          {branding ? <BrandingSettings branding={branding} onRefresh={refreshBranding} /> : <p className="text-sm text-muted-foreground">Loading branding…</p>}
        </TabsContent>

        {/* USERS */}
        <TabsContent value="users" className="mt-4 space-y-4">
          <div className="flex justify-end">
            <Button onClick={() => setUserOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" /> Create user
            </Button>
          </div>
          <DataTable
            columns={userColumns}
            rows={users?.rows}
            loading={usersLoading}
            error={usersError}
            onRetry={refreshUsers}
            emptyTitle="No users"
            page={1}
            perPage={20}
            total={users?.total ?? 0}
            toolbar={<Input placeholder="Search users…" value={userSearch} onChange={(e) => setUserSearch(e.target.value)} className="max-w-xs" />}
          />
          <p className="text-xs text-muted-foreground">
            Super Admins cannot be disabled or demoted from this screen. Disabled users cannot sign in. New
            workers also appear under Team → Workers.
          </p>
        </TabsContent>

        {/* ROLES */}
        <TabsContent value="roles" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4 text-emerald-600" /> Role permission matrix</CardTitle>
              <CardDescription>
                Enforced in the API service layer for every request and mirrored by Supabase Row Level Security
                policies — workers can only ever read their own orders, earnings and payments, even with direct
                database access.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto scrollbar-thin">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-muted/60">
                      <th className="px-3 py-2 text-left font-semibold">Area</th>
                      <th className="px-3 py-2 text-left font-semibold">Super Admin</th>
                      <th className="px-3 py-2 text-left font-semibold">Admin / Manager</th>
                      <th className="px-3 py-2 text-left font-semibold">Inventory Manager</th>
                      <th className="px-3 py-2 text-left font-semibold">Worker</th>
                    </tr>
                  </thead>
                  <tbody>
                    {PERMISSIONS_MATRIX.map((row) => (
                      <tr key={row.area} className="border-t border-border/60">
                        <td className="px-3 py-2 font-medium">{row.area}</td>
                        <td className="px-3 py-2 text-emerald-700">{row.super_admin}</td>
                        <td className="px-3 py-2">{row.admin}</td>
                        <td className="px-3 py-2">{row.inventory_manager}</td>
                        <td className="px-3 py-2 text-muted-foreground">{row.worker}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* COMMISSION RULES */}
        <TabsContent value="commission" className="mt-4 space-y-4">
          <div className="flex justify-end">
            <Button onClick={() => setRuleOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" /> Add rule
            </Button>
          </div>
          <DataTable
            columns={ruleColumns}
            rows={rules?.rows}
            emptyTitle="No rules"
            emptyDescription="Add a default rule and worker-specific overrides."
            page={1}
            perPage={50}
            total={rules?.total ?? 0}
          />
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">How commission is calculated</CardTitle></CardHeader>
            <CardContent className="space-y-1.5 text-xs leading-relaxed text-muted-foreground">
              <p>• When a worker is assigned, the current rate is <strong className="text-foreground">locked to that order</strong> — later rate changes never rewrite history.</p>
              <p>• DELIVERED credits <code>cod × rate%</code> exactly once (duplicate events are ignored).</p>
              <p>• RETURNED deducts the credited amount exactly once, so the order nets to zero.</p>
              <p>• CANCELLED never touches the ledger. {commission.deduct_on_return === false ? "(Return deductions currently disabled)" : ""}</p>
              <p>• Default rate when no worker rule matches: <strong className="text-foreground">{commission.default_rate ?? 5}%</strong></p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* FLASHIP */}
        <TabsContent value="flaship" className="mt-4 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Flaship API configuration</CardTitle>
              <CardDescription>
                The API key is stored encrypted on the server (env <code className="rounded bg-muted px-1">FLASHIP_API_KEY</code> takes
                precedence) — it is never sent back to the browser. Requests are logged with secrets redacted.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge className={flaship?.mode === "live" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}>
                  Mode: {flaship?.mode ?? "simulator"}
                </Badge>
                <Badge variant="outline">Key: {flaship?.api_key_set ? `configured ${flaship.api_key_masked ?? ""} (${flaship.api_key_source ?? "env"})` : "not set"}</Badge>
                <Badge variant="outline" className="font-mono text-[11px]">Base: {flaship?.base_url}</Badge>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label className="mb-1.5 block">API key (write-only)</Label>
                  <Input
                    type="password"
                    value={flashipKey}
                    onChange={(e) => setFlashipKey(e.target.value)}
                    placeholder={flaship?.api_key_set ? "•••••••• (leave blank to keep current)" : "Paste integration API key"}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">Stored AES-256-GCM encrypted; shown masked only.</p>
                </div>
                <div>
                  <Label className="mb-1.5 block">API base URL</Label>
                  <Input id="f-base" defaultValue={flaship?.base_url ?? "https://partners.flaship.pk/api/integration"} />
                  <p className="mt-1 text-xs text-muted-foreground">Integration API root, e.g. https://partners.flaship.pk/api/integration</p>
                </div>
                <div>
                  <Label className="mb-1.5 block">Timeout (ms)</Label>
                  <Input id="f-timeout" type="number" defaultValue={flaship?.timeout_ms ?? 30000} min={3000} max={120000} />
                </div>
                <div>
                  <Label className="mb-1.5 block">Default service type</Label>
                  <select id="f-service" defaultValue={flaship?.default_service_type ?? "overnight"} className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm">
                    <option value="overnight">Overnight</option>
                    <option value="overland">Overland</option>
                    <option value="detain">Detain</option>
                  </select>
                </div>
              </div>
              {flaship?.endpoints ? (
                <div>
                  <Label className="mb-1.5 block">Endpoint paths (Integration API)</Label>
                  <div className="grid gap-2 text-xs sm:grid-cols-3">
                    {Object.entries(flaship.endpoints).map(([k, v]) => (
                      <div key={k} className="rounded-md border border-border px-2 py-1.5">
                        <p className="font-medium capitalize">{k}</p>
                        <p className="truncate font-mono text-muted-foreground">{v}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={savingFlaship}
                  onClick={async () => {
                    setSavingFlaship(true);
                    setSaveMsg(null);
                    try {
                      await api("/api/settings", {
                        method: "PATCH",
                        json: {
                          key: "flaship",
                          value: {
                            base_url: (document.getElementById("f-base") as HTMLInputElement)?.value?.trim() || flaship?.base_url,
                            timeout_ms: Number((document.getElementById("f-timeout") as HTMLInputElement)?.value ?? 30000),
                            default_service_type: (document.getElementById("f-service") as HTMLSelectElement)?.value ?? "overnight",
                            ...(flashipKey.trim() ? { api_key: flashipKey.trim() } : {}),
                          },
                        },
                      });
                      setFlashipKey("");
                      setSaveMsg("Flaship settings saved.");
                      refreshSettings();
                    } catch (e) {
                      setSaveMsg(e instanceof Error ? e.message : "Save failed.");
                    } finally {
                      setSavingFlaship(false);
                    }
                  }}
                >
                  {savingFlaship ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  Save configuration
                </Button>
                <Button
                  variant="outline"
                  onClick={async () => {
                    setSaveMsg(null);
                    try {
                      const res = await api<{ ok: boolean; message: string }>("/api/flaship/test", { method: "POST" });
                      setSaveMsg(res.message);
                    } catch (e) {
                      setSaveMsg(e instanceof Error ? e.message : "Connection test failed.");
                    }
                  }}
                >
                  <PlugZap className="mr-2 h-4 w-4" /> Test connection
                </Button>
                <Button
                  variant="outline"
                  onClick={async () => {
                    setSaveMsg(null);
                    try {
                      const res = await api<{ count: number }>("/api/flaship/catalog", { method: "POST", json: { type: "all" } });
                      setSaveMsg(`Catalog refreshed: ${res.count} entr${res.count === 1 ? "y" : "ies"} synced (couriers, cities, pickups).`);
                    } catch (e) {
                      setSaveMsg(e instanceof Error ? e.message : "Catalog refresh failed.");
                    }
                  }}
                >
                  <RefreshCw className="mr-2 h-4 w-4" /> Refresh catalog
                </Button>
              </div>
              {saveMsg ? <p className={`text-xs ${saveMsg.startsWith("Flaship settings") || saveMsg.startsWith("Connected") || saveMsg.startsWith("Catalog") ? "text-emerald-700" : "text-rose-600"}`}>{saveMsg}</p> : null}
            </CardContent>
          </Card>

          <FlashipLogsMini />
        </TabsContent>

        {/* GENERAL */}
        <TabsContent value="general" className="mt-4">
          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-base">Business profile</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label className="mb-1.5 block">Business name</Label>
                  <Input id="g-name" defaultValue={general.business_name ?? "RoyalCarePK"} />
                </div>
                <div>
                  <Label className="mb-1.5 block">Support phone</Label>
                  <Input id="g-phone" defaultValue={general.phone ?? ""} />
                </div>
                <div>
                  <Label className="mb-1.5 block">Currency</Label>
                  <Input id="g-currency" defaultValue={general.currency ?? "PKR"} disabled />
                </div>
                <div>
                  <Label className="mb-1.5 block">Low stock threshold</Label>
                  <Input id="g-threshold" type="number" defaultValue={general.low_stock_threshold ?? 10} min={0} />
                </div>
                <div className="sm:col-span-2">
                  <Label className="mb-1.5 block">Address</Label>
                  <Input id="g-address" defaultValue={general.address ?? ""} />
                </div>
              </div>
              <Button
                disabled={savingGeneral}
                onClick={async () => {
                  setSavingGeneral(true);
                  try {
                    await api("/api/settings", {
                      method: "PATCH",
                      json: {
                        key: "general",
                        value: {
                          ...general,
                          business_name: (document.getElementById("g-name") as HTMLInputElement).value,
                          phone: (document.getElementById("g-phone") as HTMLInputElement).value,
                          address: (document.getElementById("g-address") as HTMLInputElement).value,
                          low_stock_threshold: Number((document.getElementById("g-threshold") as HTMLInputElement).value),
                          currency: (document.getElementById("g-currency") as HTMLInputElement).value,
                        },
                      },
                    });
                    setSaveMsg("General settings saved.");
                    refreshSettings();
                  } finally {
                    setSavingGeneral(false);
                  }
                }}
              >
                {savingGeneral ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Save general settings
              </Button>
              {saveMsg ? <p className="text-xs text-emerald-700">{saveMsg}</p> : null}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Create user dialog */}
      <FormDialog
        open={userOpen}
        onOpenChange={setUserOpen}
        title="Create user"
        description="Workers created here appear in Team → Workers; use that page for commission defaults."
        fields={[
          { name: "name", label: "Full name", type: "text", required: true },
          { name: "email", label: "Email", type: "email", required: true },
          { name: "phone", label: "Phone", type: "tel" },
          { name: "password", label: "Password", type: "password", required: true },
          {
            name: "role",
            label: "Role",
            type: "select",
            required: true,
            defaultValue: "worker",
            options: [
              { value: "worker", label: "Worker" },
              { value: "inventory_manager", label: "Inventory Manager" },
              { value: "admin", label: "Admin / Manager" },
            ],
          },
          { name: "commission_rate", label: "Commission rate (%) — workers only", type: "number", min: 0, max: 100, step: "0.5", defaultValue: 5 },
        ]}
        submitLabel="Create user"
        onSubmit={async (v) => {
          await api("/api/users", { method: "POST", json: { ...v, commission_rate: Number(v.commission_rate) } });
          refreshUsers();
        }}
      />

      {/* Commission rule dialog */}
      <FormDialog
        open={ruleOpen}
        onOpenChange={setRuleOpen}
        title="Add commission rule"
        fields={[
          { name: "name", label: "Rule name", type: "text", required: true, placeholder: "e.g. Usman — 10%" },
          {
            name: "scope",
            label: "Applies to",
            type: "select",
            required: true,
            defaultValue: "worker",
            options: [
              { value: "worker", label: "Specific worker" },
              { value: "default", label: "All workers (default)" },
            ],
          },
          {
            name: "worker_id",
            label: "Worker",
            type: "select",
            options: (workers?.rows ?? []).map((w) => ({ value: w.id, label: w.name })),
          },
          { name: "rate", label: "Rate (%)", type: "number", required: true, min: 0, max: 100, step: "0.5" },
          { name: "note", label: "Note", type: "textarea" },
        ]}
        submitLabel="Create rule"
        onSubmit={async (v) => {
          await api("/api/commission/rules", {
            method: "POST",
            json: { ...v, rate: Number(v.rate), worker_id: v.worker_id || null },
          });
          refreshRules();
        }}
      />
    </div>
  );
}

// ---------------- Branding tab ----------------

function BrandingSettings({ branding, onRefresh }: { branding: BrandingConfig; onRefresh: () => void }) {
  const [saving, setSaving] = useState(false);
  const [busyKind, setBusyKind] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const logoInput = useRef<HTMLInputElement>(null);
  const mobileInput = useRef<HTMLInputElement>(null);
  const faviconInput = useRef<HTMLInputElement>(null);

  const routerRefresh = () => {
    // shells re-render with fresh branding after server components refresh
    window.dispatchEvent(new CustomEvent("branding:updated"));
    setTimeout(() => window.location.reload(), 350);
  };

  const upload = async (kind: "logo" | "mobile_logo" | "favicon", input: HTMLInputElement | null) => {
    const file = input?.files?.[0];
    if (!file) return;
    setBusyKind(kind);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.append("kind", kind);
      fd.append("file", file);
      const res = await fetch("/api/branding", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error ?? "Upload failed.");
      setMsg(`${kind.replace("_", " ")} updated.`);
      onRefresh();
      routerRefresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusyKind(null);
      if (input) input.value = "";
    }
  };

  const patch = async (json: Record<string, unknown>, okMsg: string) => {
    setSaving(true);
    setMsg(null);
    try {
      await api("/api/branding", { method: "PATCH", json });
      setMsg(okMsg);
      onRefresh();
      routerRefresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Update failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><ImageIcon className="h-4 w-4" style={{ color: "var(--brand-primary)" }} /> Brand identity</CardTitle>
          <CardDescription>
            Logos, favicon and colors apply instantly across the admin console, worker app, login pages and PWA.
            If no custom logo is uploaded, the built-in {branding.brand_name} logo is used.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="mb-1.5 block">Brand name</Label>
              <Input id="b-name" defaultValue={branding.brand_name} maxLength={60} />
            </div>
            <div>
              <Label className="mb-1.5 block">Tagline (optional)</Label>
              <Input id="b-tagline" defaultValue={branding.tagline ?? ""} maxLength={120} placeholder="Business Console" />
            </div>
            <div>
              <Label className="mb-1.5 block">Primary color</Label>
              <div className="flex items-center gap-2">
                <input id="b-primary" type="color" defaultValue={branding.primary_color} className="h-9 w-14 cursor-pointer rounded-md border border-border bg-card p-1" />
                <span className="text-xs text-muted-foreground">{branding.primary_color}</span>
              </div>
            </div>
            <div>
              <Label className="mb-1.5 block">Secondary color</Label>
              <div className="flex items-center gap-2">
                <input id="b-secondary" type="color" defaultValue={branding.secondary_color} className="h-9 w-14 cursor-pointer rounded-md border border-border bg-card p-1" />
                <span className="text-xs text-muted-foreground">{branding.secondary_color}</span>
              </div>
            </div>
          </div>
          <Button
            disabled={saving}
            onClick={async () =>
              patch(
                {
                  brand_name: (document.getElementById("b-name") as HTMLInputElement).value,
                  tagline: (document.getElementById("b-tagline") as HTMLInputElement).value || null,
                  primary_color: (document.getElementById("b-primary") as HTMLInputElement).value,
                  secondary_color: (document.getElementById("b-secondary") as HTMLInputElement).value,
                },
                "Brand identity saved."
              )
            }
          >
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save brand identity
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Logos &amp; favicon</CardTitle>
          <CardDescription>PNG, JPG, SVG or WEBP up to 400 KB (favicon up to 200 KB). Previews update after save.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          {([
            { kind: "logo" as const, label: "Main / Desktop logo", input: logoInput, url: branding.logo_url },
            { kind: "mobile_logo" as const, label: "Mobile logo", input: mobileInput, url: branding.mobile_logo_url ?? branding.logo_url },
            { kind: "favicon" as const, label: "Favicon", input: faviconInput, url: branding.favicon_url },
          ]).map((asset) => (
            <div key={asset.kind} className="rounded-xl border border-border p-3">
              <p className="mb-2 text-xs font-semibold">{asset.label}</p>
              <div className="mb-3 flex h-20 items-center justify-center rounded-lg bg-muted/40 p-2">
                {asset.kind === "favicon" ? (
                  asset.url ? (
                    <img src={asset.url} alt="Favicon preview" className="h-10 w-10 rounded object-contain" />
                  ) : (
                    <img src="/icon.svg" alt="Default favicon" className="h-10 w-10 rounded object-contain" />
                  )
                ) : (
                  <BrandLogo branding={branding} variant={asset.kind === "mobile_logo" ? "mobile" : "desktop"} size={44} className="h-11 w-11 rounded-lg object-contain" />
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" variant="outline" disabled={busyKind === asset.kind} onClick={() => asset.input.current?.click()}>
                  {busyKind === asset.kind ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1.5 h-3.5 w-3.5" />}
                  {asset.url ? "Replace" : "Upload"}
                </Button>
                {asset.url ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-rose-200 text-rose-700 hover:bg-rose-50"
                    disabled={saving}
                    onClick={() =>
                      patch(
                        { action: asset.kind === "logo" ? "remove_logo" : asset.kind === "mobile_logo" ? "remove_mobile_logo" : "remove_favicon" },
                        `${asset.label} removed — default restored.`
                      )
                    }
                  >
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Remove
                  </Button>
                ) : null}
                <input
                  ref={asset.input}
                  type="file"
                  accept={asset.kind === "favicon" ? ".png,.ico,.svg,.webp,image/png,image/x-icon,image/svg+xml,image/webp" : ".png,.jpg,.jpeg,.svg,.webp,image/png,image/jpeg,image/svg+xml,image/webp"}
                  className="hidden"
                  onChange={(e) => void upload(asset.kind, e.target)}
                />
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">{asset.url ? "Custom asset active" : "Using built-in default"}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          disabled={saving}
          onClick={() => {
            if (window.confirm("Restore the default RoyalCarePK branding? Custom logos, favicon and colors will be reset.")) {
              void patch({ action: "restore_defaults" }, "Default branding restored.");
            }
          }}
        >
          <RotateCcw className="mr-2 h-4 w-4" /> Restore default branding
        </Button>
      </div>
      {msg ? <p className={`text-xs ${/saved|updated|removed|restored/.test(msg) ? "text-emerald-700" : "text-rose-600"}`}>{msg}</p> : null}
    </div>
  );
}

function FlashipLogsMini() {
  const { data, loading, error, refresh } = useList<Record<string, unknown>>("/api/flaship/logs?perPage=10");
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between pb-3">
        <div>
          <CardTitle className="text-base">Recent API logs</CardTitle>
          <CardDescription>Request/response log with secrets redacted</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={refresh}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-rose-600">{error}</p>
        ) : !data || data.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No API calls yet. Book an order to see logs here.</p>
        ) : (
          <div className="space-y-2">
            {data.rows.map((l) => (
              <div key={l.id as string} className="rounded-lg border border-border px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className={l.success ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"}>
                    {String(l.method)} {String(l.status_code ?? "—")}
                  </Badge>
                  <span className="font-mono">{String(l.endpoint)}</span>
                  <span className="text-muted-foreground">{formatDateTime(l.created_at as string)} · {String(l.duration_ms ?? 0)}ms</span>
                </div>
                {l.error ? <p className="mt-1 text-rose-600">{String(l.error)}</p> : null}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  return (
    <Suspense>
      <SettingsContent />
    </Suspense>
  );
}
