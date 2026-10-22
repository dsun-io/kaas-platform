"use client";

import { useState } from "react";
import { usePageView } from "@/lib/events/use-page-view";
import { RouteGuard } from "@/components/route-guard";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  PageHeader,
  StatusBadge,
  SectionCard,
  EmptyState,
} from "@/components/shared";
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
  pending: "default",
  sending: "info",
  sent: "info",
  delivered: "info",
  opened: "purple",
  replied: "success",
  bounced: "danger",
  failed: "danger",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "待发送",
  sending: "发送中",
  sent: "已发送",
  delivered: "已送达",
  opened: "已打开",
  replied: "已回复",
  bounced: "退信",
  failed: "失败",
  draft: "草稿",
};

/* ── page ──────────────────────────────────────────────────────────────── */
export default function OutreachPage() {
  usePageView({ resource_id: "/outreach" });
  const qc = useQueryClient();
  const [mbForm, setMbForm] = useState({
    email: "",
    name: "",
    api_key: "",
    is_default: true,
  });
  const [campForm, setCampForm] = useState({
    name: "",
    subject_template: "",
    body_template: "",
  });
  const [sendingCampaign, setSendingCampaign] = useState<Campaign | null>(null);
  const [leadSearch, setLeadSearch] = useState("");
  const [selectedLeads, setSelectedLeads] = useState<number[]>([]);
  const [msgFilter, setMsgFilter] = useState("");
  const [openMsg, setOpenMsg] = useState<Message | null>(null);

  const { data: mbData, refetch: refetchMb } = useQuery({
    queryKey: ["outreach-mailboxes"],
    queryFn: async () =>
      (await apiClient.get<{ items: Mailbox[] }>("/outreach/mailboxes")).data,
  });
  const mailboxes = mbData?.items ?? [];

  const { data: campData, refetch: refetchCamp } = useQuery({
    queryKey: ["outreach-campaigns"],
    queryFn: async () =>
      (await apiClient.get<{ items: Campaign[] }>("/outreach/campaigns")).data,
  });
  const campaigns = campData?.items ?? [];

  const { data: msgData, refetch: refetchMsg } = useQuery({
    queryKey: ["outreach-messages", msgFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ page_size: "100" });
      if (msgFilter) params.set("status", msgFilter);
      return (
        await apiClient.get<{ items: Message[] }>(
          `/outreach/messages?${params}`,
        )
      ).data;
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
        email: mbForm.email,
        name: mbForm.name || null,
        api_key: mbForm.api_key || null,
        is_default: mbForm.is_default,
      });
      toast.success("邮箱已保存");
      setMbForm({ email: "", name: "", api_key: "", is_default: true });
      refetchMb();
    } catch {
      toast.error("保存失败");
    }
  };

  const setDefault = async (m: Mailbox) => {
    await apiClient.patch(`/outreach/mailboxes/${m.id}`, { is_default: true });
    toast.success(`${m.email} 已设为默认发件人`);
    refetchMb();
  };

  const testMailbox = async (m: Mailbox) => {
    const to = window.prompt(`从 ${m.email} 发送测试邮件至：`);
    if (!to) return;
    try {
      const { data } = await apiClient.post<{ status: string; error?: string }>(
        `/outreach/mailboxes/${m.id}/test?to=${encodeURIComponent(to)}`,
      );
      data.status === "sent"
        ? toast.success("测试邮件已发送")
        : toast.error(`测试失败：${data.error ?? ""}`);
    } catch {
      toast.error("测试失败");
    }
  };

  const aiGenerate = async () => {
    try {
      const { data } = await apiClient.post<{
        result: { subject?: string; body?: string; text?: string };
        path: string;
      }>("/outreach/generate", {
        payload: {
          purpose: "cold_outreach",
          product: "wire mesh & fencing",
          tone: "professional",
        },
      });
      const r = data.result as { subject?: string; body?: string };
      setCampForm((f) => ({
        ...f,
        subject_template: r.subject ?? f.subject_template,
        body_template: r.body ?? f.body_template,
      }));
      toast.success(`草稿已通过 ${data.path} 生成`);
    } catch {
      toast.error("AI 生成失败");
    }
  };

  const createCampaign = async () => {
    try {
      await apiClient.post("/outreach/campaigns", {
        name: campForm.name,
        subject_template: campForm.subject_template,
        body_template: campForm.body_template,
      });
      toast.success("营销活动已创建");
      setCampForm({ name: "", subject_template: "", body_template: "" });
      refetchCamp();
    } catch {
      toast.error("创建失败");
    }
  };

  const sendCampaign = async () => {
    if (!sendingCampaign) return;
    try {
      const { data } = await apiClient.post<{
        total: number;
        sent: number;
        failed: number;
      }>(`/outreach/campaigns/${sendingCampaign.id}/send`, {
        lead_ids: selectedLeads,
      });
      toast.success(`发送完成：成功 ${data.sent}，失败 ${data.failed}`);
      setSendingCampaign(null);
      setSelectedLeads([]);
      refetchCamp();
      refetchMsg();
      qc.invalidateQueries({ queryKey: ["leads"] });
    } catch {
      toast.error("发送失败");
    }
  };

  const retryMessage = async (m: Message) => {
    try {
      const { data } = await apiClient.post<{ status: string }>(
        `/outreach/messages/${m.id}/retry`,
      );
      toast[data.status === "sent" ? "success" : "error"](
        `重试 → ${data.status}`,
      );
      refetchMsg();
      refetchCamp();
    } catch {
      toast.error("重试失败");
    }
  };

  const viewMessage = async (m: Message) => {
    try {
      const { data } = await apiClient.get<Message>(
        `/outreach/messages/${m.id}`,
      );
      setOpenMsg(data);
    } catch {
      toast.error("加载失败");
    }
  };

  return (
    <RouteGuard>
      <PageHeader
        title="邮件外联"
        description="发件邮箱、营销活动与按收件人的投递跟踪"
      />
      <div className="space-y-6 p-6">
        {/* mailboxes */}
        <SectionCard title="发件邮箱">
          <div className="mb-3 flex flex-wrap items-end gap-2">
            <Input
              className="w-56"
              placeholder="发件邮箱地址 *"
              value={mbForm.email}
              onChange={(e) => setMbForm({ ...mbForm, email: e.target.value })}
            />
            <Input
              className="w-40"
              placeholder="显示名称"
              value={mbForm.name}
              onChange={(e) => setMbForm({ ...mbForm, name: e.target.value })}
            />
            <Input
              className="w-56"
              placeholder="发信服务密钥（可选，留空则用系统默认配置）"
              value={mbForm.api_key}
              onChange={(e) =>
                setMbForm({ ...mbForm, api_key: e.target.value })
              }
            />
            <label className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={mbForm.is_default}
                onChange={(e) =>
                  setMbForm({ ...mbForm, is_default: e.target.checked })
                }
              />
              默认
            </label>
            <Button size="sm" onClick={addMailbox} disabled={!mbForm.email}>
              <MailPlus className="mr-1 h-4 w-4" /> 添加邮箱
            </Button>
          </div>
          {mailboxes.length === 0 ? (
            <EmptyState
              title="暂无邮箱"
              description="添加一个邮箱即可开始发送"
            />
          ) : (
            <div className="space-y-1">
              {mailboxes.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center gap-3 rounded border px-3 py-2 text-sm"
                >
                  <span className="font-medium">{m.email}</span>
                  <span className="text-muted-foreground">{m.name}</span>
                  {m.is_default && (
                    <Badge className="bg-blue-100 text-blue-800">默认</Badge>
                  )}
                  <span className="text-xs text-muted-foreground">
                    发信服务：
                    {m.has_own_key ? "已配置" : "未配置（使用系统默认）"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    今日：{m.sent_today}
                    {m.daily_limit ? `/${m.daily_limit}` : ""}
                  </span>
                  <span className="ml-auto flex gap-1">
                    {!m.is_default && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setDefault(m)}
                      >
                        设为默认
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => testMailbox(m)}
                    >
                      测试
                    </Button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        {/* campaigns */}
        <SectionCard title="营销活动">
          <div className="mb-3 space-y-2">
            <div className="flex flex-wrap gap-2">
              <Input
                className="w-48"
                placeholder="活动名称 *"
                value={campForm.name}
                onChange={(e) =>
                  setCampForm({ ...campForm, name: e.target.value })
                }
              />
              <Button variant="outline" size="sm" onClick={aiGenerate}>
                <Sparkles className="mr-1 h-4 w-4" /> AI 起草
              </Button>
            </div>
            <Input
              placeholder="邮件主题模板 — 变量：{{name}} {{company}} {{city}} {{country}} {{region}} {{opening_line}} {{sender_name}}"
              value={campForm.subject_template}
              onChange={(e) =>
                setCampForm({ ...campForm, subject_template: e.target.value })
              }
            />
            <textarea
              className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm"
              placeholder="正文模板（变量同上）"
              value={campForm.body_template}
              onChange={(e) =>
                setCampForm({ ...campForm, body_template: e.target.value })
              }
            />
            <Button
              size="sm"
              onClick={createCampaign}
              disabled={
                !campForm.name ||
                !campForm.subject_template ||
                !campForm.body_template
              }
            >
              创建活动
            </Button>
          </div>
          {campaigns.length === 0 ? (
            <EmptyState title="暂无活动" />
          ) : (
            <div className="space-y-1">
              {campaigns.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center gap-3 rounded border px-3 py-2 text-sm"
                >
                  <span className="font-medium">{c.name}</span>
                  <StatusBadge
                    tone={
                      c.status === "sent"
                        ? "success"
                        : c.status === "sending"
                          ? "info"
                          : "default"
                    }
                  >
                    {STATUS_LABELS[c.status] ?? c.status}
                  </StatusBadge>
                  <span className="text-xs text-muted-foreground">
                    共 {c.total_count} · 已发送 {c.sent_count} · 失败{" "}
                    {c.failed_count}
                  </span>
                  <span className="ml-auto">
                    <Button
                      size="sm"
                      onClick={() => {
                        setSendingCampaign(c);
                        setSelectedLeads([]);
                      }}
                    >
                      <Send className="mr-1 h-4 w-4" /> 发送…
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
                <h3 className="font-semibold">
                  为“{sendingCampaign.name}”选择潜在客户
                </h3>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSendingCampaign(null)}
                >
                  取消
                </Button>
              </div>
              <Input
                className="mb-2 w-64"
                placeholder="搜索潜在客户…"
                value={leadSearch}
                onChange={(e) => setLeadSearch(e.target.value)}
              />
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {pickerLeads.map((l) => (
                  <label
                    key={l.id}
                    className="flex items-center gap-2 rounded border px-3 py-1.5 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={selectedLeads.includes(l.id)}
                      onChange={(e) =>
                        setSelectedLeads(
                          e.target.checked
                            ? [...selectedLeads, l.id]
                            : selectedLeads.filter((x) => x !== l.id),
                        )
                      }
                    />
                    <span className="font-medium">{l.company_name}</span>
                    <span className="text-xs text-muted-foreground">
                      {[l.city, l.country].filter(Boolean).join(", ")}
                    </span>
                    {!l.email && (
                      <Badge className="bg-destructive/10 text-destructive">
                        无邮箱
                      </Badge>
                    )}
                    <span className="ml-auto">
                      <StatusBadge tone="default">
                        {STATUS_LABELS[l.outreach_status] ?? l.outreach_status}
                      </StatusBadge>
                    </span>
                  </label>
                ))}
                {pickerLeads.length === 0 && (
                  <div className="text-sm text-muted-foreground">
                    没有匹配的潜在客户
                  </div>
                )}
              </div>
              <Button
                className="mt-3"
                size="sm"
                disabled={selectedLeads.length === 0}
                onClick={sendCampaign}
              >
                <Send className="mr-1 h-4 w-4" /> 发送给 {selectedLeads.length}{" "}
                个潜在客户
              </Button>
            </div>
          )}
        </SectionCard>

        {/* messages */}
        <SectionCard title="消息记录">
          <div className="mb-3">
            <select
              className="rounded-md border bg-background px-3 py-2 text-sm"
              value={msgFilter}
              onChange={(e) => setMsgFilter(e.target.value)}
            >
              <option value="">状态：全部</option>
              {Object.keys(MSG_TONES).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s] ?? s}
                </option>
              ))}
            </select>
          </div>
          {messages.length === 0 ? (
            <EmptyState title="暂无消息" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th scope="col" className="p-2">
                      收件人
                    </th>
                    <th scope="col" className="p-2">
                      主题
                    </th>
                    <th scope="col" className="p-2">
                      状态
                    </th>
                    <th scope="col" className="p-2">
                      发送时间
                    </th>
                    <th scope="col" className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {messages.map((m) => (
                    <tr key={m.id} className="border-b hover:bg-muted/40">
                      <td className="p-2">
                        <div className="font-medium">{m.to_name ?? "—"}</div>
                        <div className="text-xs text-muted-foreground">
                          {m.to_email || "—"}
                        </div>
                      </td>
                      <td className="p-2 text-xs">{m.subject}</td>
                      <td className="p-2">
                        <StatusBadge tone={MSG_TONES[m.status] ?? "default"}>
                          {STATUS_LABELS[m.status] ?? m.status}
                        </StatusBadge>
                        {m.error && (
                          <div
                            className="mt-1 max-w-48 truncate text-xs text-destructive"
                            title={m.error}
                          >
                            {m.error}
                          </div>
                        )}
                      </td>
                      <td className="p-2 text-xs text-muted-foreground">
                        {m.sent_at?.slice(0, 19) ?? "—"}
                      </td>
                      <td className="p-2">
                        <span className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => viewMessage(m)}
                          >
                            查看
                          </Button>
                          {(m.status === "failed" ||
                            m.status === "bounced") && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => retryMessage(m)}
                            >
                              <RotateCcw className="mr-1 h-3 w-3" /> 重试
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
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setOpenMsg(null)}
                >
                  关闭
                </Button>
              </div>
              <div className="mb-2 text-xs text-muted-foreground">
                收件人：{openMsg.to_name} &lt;{openMsg.to_email}&gt; · 活动 #
                {openMsg.campaign_id ?? "—"} · 潜在客户 #
                {openMsg.lead_id ?? "—"}
              </div>
              <pre className="whitespace-pre-wrap rounded bg-muted p-3 text-sm">
                {openMsg.body_rendered ?? "—"}
              </pre>
            </div>
          )}
        </SectionCard>
      </div>
    </RouteGuard>
  );
}
