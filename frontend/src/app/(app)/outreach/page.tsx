"use client";

import { useState } from "react";
import { usePageView } from "@/lib/events/use-page-view";
import { RouteGuard } from "@/components/route-guard";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageHeader, StatusBadge, SectionCard, EmptyState } from "@/components/shared";
import { toast } from "sonner";
import { MailPlus, Send, Sparkles, RotateCcw } from "lucide-react";

/* ── types ─────────────────────────────────────────────────────────────── */
interface Mailbox {
  id: number;
  email: string;
  name: string | null;
  api_key_masked: string | null;
  has_own_key: boolean;
  is_default: boolean;
  daily_limit: number | null;
  sent_today: number;
  enabled: boolean;
}

interface Campaign {
  id: number;
  name: string;
  subject_template: string;
  body_template: string;
  status: string;
  total_count: number;
  sent_count: number;
  failed_count: number;
  created_at: string;
}

interface Message {
  id: number;
  campaign_id: number | null;
  lead_id: number | null;
  to_email: string;
  to_name: string | null;
  subject: string;
  body_rendered?: string;
  status: string;
  error: string | null;
  sent_at: string | null;
}

interface Lead {
  id: number;
  company_name: string;
  city: string | null;
  country: string | null;
  email: string | null;
  outreach_status: string;
}

const MSG_TONES: Record<string, import("@/components/shared").StatusTone> = {
  pending: "default", sending: "info", sent: "info", delivered: "info",
  opened: "purple", replied: "success", bounced: "danger", failed: "danger",
};

/* ── page ──────────────────────────────────────────────────────────────── */
export default function OutreachPage() {
  usePageView({ resource_id: "/outreach" });
  const qc = useQueryClient();
  const [mbForm, setMbForm] = useState({ email: "", name: "", api_key: "", is_default: true });
  const [campForm, setCampForm] = useState({ name: "", subject_template: "", body_template: "" });
  const [sendingCampaign, setSendingCampaign] = useState<Campaign | null>(null);
  const [leadSearch, setLeadSearch] = useState("");
  const [selectedLeads, setSelectedLeads] = useState<number[]>([]);
  const [msgFilter, setMsgFilter] = useState("");
  const [openMsg, setOpenMsg] = useState<Message | null>(null);

  const { data: mbData, refetch: refetchMb } = useQuery({
    queryKey: ["outreach-mailboxes"],
    queryFn: async () => (await apiClient.get<{ items: Mailbox[] }>("/outreach/mailboxes")).data,
  });
  const mailboxes = mbData?.items ?? [];

  const { data: campData, refetch: refetchCamp } = useQuery({
    queryKey: ["outreach-campaigns"],
    queryFn: async () => (await apiClient.get<{ items: Campaign[] }>("/outreach/campaigns")).data,
  });
  const campaigns = campData?.items ?? [];

  const { data: msgData, refetch: refetchMsg } = useQuery({
    queryKey: ["outreach-messages", msgFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ page_size: "100" });
      if (msgFilter) params.set("status", msgFilter);
      return (await apiClient.get<{ items: Message[] }>(`/outreach/messages?${params}`)).data;
    },
  });
  const messages = msgData?.items ?? [];

  const { data: leadData } = useQuery({
    queryKey: ["outreach-lead-picker", leadSearch],
    queryFn: async () => {
      const params = new URLSearchParams({ page_size: "50", sort: "score" });
      if (leadSearch) params.set("search", leadSearch);
      return (await apiClient.get<{ items: Lead[] }>(`/leads?${params}`)).data;
    },
    enabled: sendingCampaign !== null,
  });
  const pickerLeads = leadData?.items ?? [];

  const addMailbox = async () => {
    try {
      await apiClient.post("/outreach/mailboxes", {
        email: mbForm.email, name: mbForm.name || null,
        api_key: mbForm.api_key || null, is_default: mbForm.is_default,
      });
      toast.success("Mailbox saved");
      setMbForm({ email: "", name: "", api_key: "", is_default: true });
      refetchMb();
    } catch { toast.error("Save failed"); }
  };

  const setDefault = async (m: Mailbox) => {
    await apiClient.patch(`/outreach/mailboxes/${m.id}`, { is_default: true });
    toast.success(`${m.email} is now the default sender`);
    refetchMb();
  };

  const testMailbox = async (m: Mailbox) => {
    const to = window.prompt(`Send a test email from ${m.email} to:`);
    if (!to) return;
    try {
      const { data } = await apiClient.post<{ status: string; error?: string }>(
        `/outreach/mailboxes/${m.id}/test?to=${encodeURIComponent(to)}`);
      data.status === "sent" ? toast.success("Test email sent") : toast.error(`Test failed: ${data.error ?? ""}`);
    } catch { toast.error("Test failed"); }
  };

  const aiGenerate = async () => {
    try {
      const { data } = await apiClient.post<{ result: { subject?: string; body?: string; text?: string }; path: string }>(
        "/outreach/generate",
        { payload: { purpose: "cold_outreach", product: "wire mesh & fencing", tone: "professional" } },
      );
      const r = data.result as { subject?: string; body?: string };
      setCampForm((f) => ({
        ...f,
        subject_template: r.subject ?? f.subject_template,
        body_template: r.body ?? f.body_template,
      }));
      toast.success(`Draft generated via ${data.path}`);
    } catch { toast.error("AI generation failed"); }
  };

  const createCampaign = async () => {
    try {
      await apiClient.post("/outreach/campaigns", {
        name: campForm.name, subject_template: campForm.subject_template,
        body_template: campForm.body_template,
      });
      toast.success("Campaign created");
      setCampForm({ name: "", subject_template: "", body_template: "" });
      refetchCamp();
    } catch { toast.error("Create failed"); }
  };

  const sendCampaign = async () => {
    if (!sendingCampaign) return;
    try {
      const { data } = await apiClient.post<{ total: number; sent: number; failed: number }>(
        `/outreach/campaigns/${sendingCampaign.id}/send`, { lead_ids: selectedLeads });
      toast.success(`Send finished: ${data.sent} sent, ${data.failed} failed`);
      setSendingCampaign(null);
      setSelectedLeads([]);
      refetchCamp(); refetchMsg();
      qc.invalidateQueries({ queryKey: ["leads"] });
    } catch { toast.error("Send failed"); }
  };

  const retryMessage = async (m: Message) => {
    try {
      const { data } = await apiClient.post<{ status: string }>(`/outreach/messages/${m.id}/retry`);
      toast[data.status === "sent" ? "success" : "error"](`Retry → ${data.status}`);
      refetchMsg(); refetchCamp();
    } catch { toast.error("Retry failed"); }
  };

  const viewMessage = async (m: Message) => {
    try {
      const { data } = await apiClient.get<Message>(`/outreach/messages/${m.id}`);
      setOpenMsg(data);
    } catch { toast.error("Load failed"); }
  };

  return (
    <RouteGuard>
      <PageHeader title="Outreach" description="Mailboxes, campaigns and per-recipient delivery tracking" />
      <div className="space-y-6 p-6">
        {/* mailboxes */}
        <SectionCard title="Sender Mailboxes">
          <div className="mb-3 flex flex-wrap items-end gap-2">
            <Input className="w-56" placeholder="sender@yourdomain.com *" value={mbForm.email}
              onChange={(e) => setMbForm({ ...mbForm, email: e.target.value })} />
            <Input className="w-40" placeholder="Display name" value={mbForm.name}
              onChange={(e) => setMbForm({ ...mbForm, name: e.target.value })} />
            <Input className="w-56" placeholder="Resend API key (optional, env fallback)" value={mbForm.api_key}
              onChange={(e) => setMbForm({ ...mbForm, api_key: e.target.value })} />
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={mbForm.is_default}
                onChange={(e) => setMbForm({ ...mbForm, is_default: e.target.checked })} />
              Default
            </label>
            <Button size="sm" onClick={addMailbox} disabled={!mbForm.email}>
              <MailPlus className="mr-1 h-4 w-4" /> Add mailbox
            </Button>
          </div>
          {mailboxes.length === 0 ? <EmptyState title="No mailboxes" description="Add one to start sending" /> : (
            <div className="space-y-1">
              {mailboxes.map((m) => (
                <div key={m.id} className="flex items-center gap-3 rounded border px-3 py-2 text-sm">
                  <span className="font-medium">{m.email}</span>
                  <span className="text-muted-foreground">{m.name}</span>
                  {m.is_default && <Badge className="bg-blue-100 text-blue-800">default</Badge>}
                  <span className="text-xs text-muted-foreground">key: {m.api_key_masked ?? "env RESEND_API_KEY"}</span>
                  <span className="text-xs text-muted-foreground">today: {m.sent_today}{m.daily_limit ? `/${m.daily_limit}` : ""}</span>
                  <span className="ml-auto flex gap-1">
                    {!m.is_default && <Button variant="outline" size="sm" onClick={() => setDefault(m)}>Set default</Button>}
                    <Button variant="outline" size="sm" onClick={() => testMailbox(m)}>Test</Button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        {/* campaigns */}
        <SectionCard title="Campaigns">
          <div className="mb-3 space-y-2">
            <div className="flex flex-wrap gap-2">
              <Input className="w-48" placeholder="Campaign name *" value={campForm.name}
                onChange={(e) => setCampForm({ ...campForm, name: e.target.value })} />
              <Button variant="outline" size="sm" onClick={aiGenerate}>
                <Sparkles className="mr-1 h-4 w-4" /> AI draft
              </Button>
            </div>
            <Input placeholder="Subject template — vars: {{name}} {{company}} {{city}} {{country}} {{region}} {{opening_line}} {{sender_name}}" value={campForm.subject_template}
              onChange={(e) => setCampForm({ ...campForm, subject_template: e.target.value })} />
            <textarea className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm" placeholder="Body template (same variables)" value={campForm.body_template}
              onChange={(e) => setCampForm({ ...campForm, body_template: e.target.value })} />
            <Button size="sm" onClick={createCampaign} disabled={!campForm.name || !campForm.subject_template || !campForm.body_template}>
              Create campaign
            </Button>
          </div>
          {campaigns.length === 0 ? <EmptyState title="No campaigns" /> : (
            <div className="space-y-1">
              {campaigns.map((c) => (
                <div key={c.id} className="flex items-center gap-3 rounded border px-3 py-2 text-sm">
                  <span className="font-medium">{c.name}</span>
                  <StatusBadge tone={c.status === "sent" ? "success" : c.status === "sending" ? "info" : "default"}>{c.status}</StatusBadge>
                  <span className="text-xs text-muted-foreground">total {c.total_count} · sent {c.sent_count} · failed {c.failed_count}</span>
                  <span className="ml-auto">
                    <Button size="sm" onClick={() => { setSendingCampaign(c); setSelectedLeads([]); }}>
                      <Send className="mr-1 h-4 w-4" /> Send…
                    </Button>
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* lead picker */}
          {sendingCampaign && (
            <div className="mt-4 rounded-md border p-4">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="font-semibold">Select leads for “{sendingCampaign.name}”</h3>
                <Button variant="ghost" size="sm" onClick={() => setSendingCampaign(null)}>Cancel</Button>
              </div>
              <Input className="mb-2 w-64" placeholder="Search leads…" value={leadSearch}
                onChange={(e) => setLeadSearch(e.target.value)} />
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {pickerLeads.map((l) => (
                  <label key={l.id} className="flex items-center gap-2 rounded border px-3 py-1.5 text-sm">
                    <input type="checkbox" checked={selectedLeads.includes(l.id)}
                      onChange={(e) => setSelectedLeads(e.target.checked ? [...selectedLeads, l.id] : selectedLeads.filter((x) => x !== l.id))} />
                    <span className="font-medium">{l.company_name}</span>
                    <span className="text-xs text-muted-foreground">{[l.city, l.country].filter(Boolean).join(", ")}</span>
                    {!l.email && <Badge className="bg-red-100 text-red-800">no email</Badge>}
                    <span className="ml-auto"><StatusBadge tone="default">{l.outreach_status}</StatusBadge></span>
                  </label>
                ))}
                {pickerLeads.length === 0 && <div className="text-sm text-muted-foreground">No leads match</div>}
              </div>
              <Button className="mt-3" size="sm" disabled={selectedLeads.length === 0} onClick={sendCampaign}>
                <Send className="mr-1 h-4 w-4" /> Send to {selectedLeads.length} lead(s)
              </Button>
            </div>
          )}
        </SectionCard>

        {/* messages */}
        <SectionCard title="Messages">
          <div className="mb-3">
            <select className="rounded-md border bg-background px-3 py-2 text-sm" value={msgFilter}
              onChange={(e) => setMsgFilter(e.target.value)}>
              <option value="">Status: all</option>
              {Object.keys(MSG_TONES).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          {messages.length === 0 ? <EmptyState title="No messages yet" /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="p-2">To</th><th className="p-2">Subject</th><th className="p-2">Status</th>
                    <th className="p-2">Sent at</th><th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {messages.map((m) => (
                    <tr key={m.id} className="border-b hover:bg-muted/40">
                      <td className="p-2">
                        <div className="font-medium">{m.to_name ?? "—"}</div>
                        <div className="text-xs text-muted-foreground">{m.to_email || "—"}</div>
                      </td>
                      <td className="p-2 text-xs">{m.subject}</td>
                      <td className="p-2">
                        <StatusBadge tone={MSG_TONES[m.status] ?? "default"}>{m.status}</StatusBadge>
                        {m.error && <div className="mt-1 max-w-48 truncate text-xs text-red-600" title={m.error}>{m.error}</div>}
                      </td>
                      <td className="p-2 text-xs text-muted-foreground">{m.sent_at?.slice(0, 19) ?? "—"}</td>
                      <td className="p-2">
                        <span className="flex gap-1">
                          <Button variant="ghost" size="sm" onClick={() => viewMessage(m)}>View</Button>
                          {(m.status === "failed" || m.status === "bounced") && (
                            <Button variant="outline" size="sm" onClick={() => retryMessage(m)}>
                              <RotateCcw className="mr-1 h-3 w-3" /> Retry
                            </Button>
                          )}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {openMsg && (
            <div className="mt-4 rounded-md border p-4">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="font-semibold">{openMsg.subject}</h3>
                <Button variant="ghost" size="sm" onClick={() => setOpenMsg(null)}>Close</Button>
              </div>
              <div className="mb-2 text-xs text-muted-foreground">
                To: {openMsg.to_name} &lt;{openMsg.to_email}&gt; · Campaign #{openMsg.campaign_id ?? "—"} · Lead #{openMsg.lead_id ?? "—"}
              </div>
              <pre className="whitespace-pre-wrap rounded bg-muted p-3 text-sm">{openMsg.body_rendered ?? "—"}</pre>
            </div>
          )}
        </SectionCard>
      </div>
    </RouteGuard>
  );
}
