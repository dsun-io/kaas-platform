"use client";

import { useRef, useState } from "react";
import { usePageView } from "@/lib/events/use-page-view";
import { RouteGuard } from "@/components/route-guard";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { normalizeApiError } from "@/lib/api/api-error";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { DetailDrawer } from "@/components/shared/detail-drawer";
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
import { TestMailboxDialog } from "./components/test-mailbox-dialog";

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
  // P0-B1：批量外发二次确认 + 提交中禁用（防止连点重复发送）
  const [sendConfirmOpen, setSendConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const sendingRef = useRef(false);
  // P0-B4：AI 起草是外部 AI 调用，连点会重复计费/重复覆盖草稿 ⇒ pending 防重
  const [generating, setGenerating] = useState(false);
  const generatingRef = useRef(false);
  // P0-B1：测试邮件收件人从 window.prompt 改为弹窗
  const [testTarget, setTestTarget] = useState<Mailbox | null>(null);
  // P0-B2：设为默认发件人的失败出口与行级 pending
  const [defaultingId, setDefaultingId] = useState<number | null>(null);
  const [defaultError, setDefaultError] = useState<string | null>(null);

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

  /**
   * P0-B2/O35-O40：设为默认发件人原本无 try/catch（失败即未处理 rejection、
   * 按钮无 pending）。现在：pending 期间禁用该行按钮 + 失败页内说明（拦截器已 toast，
   * 不重复 toast）。
   */
  const setDefault = async (m: Mailbox) => {
    if (defaultingId === m.id) return;
    setDefaultingId(m.id);
    setDefaultError(null);
    try {
      await apiClient.patch(`/outreach/mailboxes/${m.id}`, {
        is_default: true,
      });
      toast.success(`${m.email} 已设为默认发件人`);
      refetchMb();
    } catch (err) {
      setDefaultError(normalizeApiError(err).message);
    } finally {
      setDefaultingId(null);
    }
  };

  /** 测试邮件：只打开收件人弹窗，真实请求在弹窗里提交（可禁用、可显示原因）。 */
  const testMailbox = (m: Mailbox) => {
    setTestTarget(m);
  };

  /** P0-B4：AI 起草待请求期间禁用按钮（`generatingRef` 兜住同一 tick 连点）。 */
  const aiGenerate = async () => {
    if (generatingRef.current) return;
    generatingRef.current = true;
    setGenerating(true);
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
    } finally {
      generatingRef.current = false;
      setGenerating(false);
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

  /**
   * P0-B1：批量外发是不可撤回动作 —— 必须先确认，且提交中禁用按钮。
   * `sendingRef` 兜住"同一 tick 连点两次"（此时 `sending` 还没随重渲染生效）。
   */
  const doSendCampaign = async () => {
    if (!sendingCampaign || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    try {
      const { data } = await apiClient.post<{
        total: number;
        sent: number;
        failed: number;
      }>(`/outreach/campaigns/${sendingCampaign.id}/send`, {
        lead_ids: selectedLeads,
      });
      toast.success(`发送完成：成功 ${data.sent}，失败 ${data.failed}`);
      setSendConfirmOpen(false);
      setSendingCampaign(null);
      setSelectedLeads([]);
      refetchCamp();
      refetchMsg();
      qc.invalidateQueries({ queryKey: ["leads"] });
    } catch (err) {
      // 失败如实透出在弹窗里，弹窗不关（用户可重试或取消）
      setSendError(normalizeApiError(err).message);
    } finally {
      sendingRef.current = false;
      setSending(false);
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
          {/* P0-B2：设为默认失败要有出口（拦截器已 toast，这里保留原因） */}
          {defaultError ? (
            <p
              role="alert"
              className="mb-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              设为默认失败：{defaultError}
            </p>
          ) : null}
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
                        onClick={() => void setDefault(m)}
                        disabled={defaultingId === m.id}
                      >
                        {defaultingId === m.id ? "设置中…" : "设为默认"}
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
              <Button
                variant="outline"
                size="sm"
                onClick={() => void aiGenerate()}
                disabled={generating}
              >
                <Sparkles className="mr-1 h-4 w-4" />{" "}
                {generating ? "起草中…" : "AI 起草"}
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
                        setSendError(null);
                        setSendConfirmOpen(false);
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
                disabled={selectedLeads.length === 0 || sending}
                onClick={() => {
                  setSendError(null);
                  setSendConfirmOpen(true);
                }}
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
        </SectionCard>
      </div>

      {/* X3（审计 §1.5）：邮件正文从「表格下方内联块」改为右侧 DetailDrawer ——
          内联块会把表格越推越长，且与行内重试/关闭混在一起；抽屉保留同一份数据来源。 */}
      <DetailDrawer
        open={openMsg !== null}
        onOpenChange={(open) => {
          if (!open) setOpenMsg(null);
        }}
        title={openMsg?.subject ?? ""}
        description={
          openMsg
            ? `收件人：${openMsg.to_name ?? "—"} <${openMsg.to_email}>`
            : undefined
        }
        widthClassName="sm:max-w-2xl"
      >
        {openMsg ? (
          <div className="space-y-4">
            <dl className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
              <div className="flex gap-2">
                <dt className="shrink-0">状态</dt>
                <dd>
                  <StatusBadge tone={MSG_TONES[openMsg.status] ?? "default"}>
                    {STATUS_LABELS[openMsg.status] ?? openMsg.status}
                  </StatusBadge>
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="shrink-0">发送时间</dt>
                <dd>{openMsg.sent_at?.slice(0, 19) ?? "—"}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="shrink-0">活动</dt>
                <dd>#{openMsg.campaign_id ?? "—"}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="shrink-0">潜在客户</dt>
                <dd>#{openMsg.lead_id ?? "—"}</dd>
              </div>
            </dl>
            {openMsg.error ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
              >
                发送失败：{openMsg.error}
              </p>
            ) : null}
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                邮件正文（渲染后）
              </p>
              <pre className="whitespace-pre-wrap rounded bg-muted p-3 text-sm">
                {openMsg.body_rendered ?? "—"}
              </pre>
            </div>
          </div>
        ) : null}
      </DetailDrawer>

      {/* P0-B1：测试邮件收件人弹窗（替代 window.prompt） */}
      <TestMailboxDialog
        mailbox={testTarget}
        onOpenChange={(open) => {
          if (!open) setTestTarget(null);
        }}
      />

      {/* P0-B1：批量群发二次确认 —— 批量外发不可撤回 */}
      <ConfirmDialog
        open={sendConfirmOpen}
        onOpenChange={(open) => {
          if (!open && !sendingRef.current) {
            setSendConfirmOpen(false);
            setSendError(null);
          } else if (open) {
            setSendConfirmOpen(true);
          }
        }}
        title={`向 ${selectedLeads.length} 个潜在客户群发邮件？`}
        description={`将以「${sendingCampaign?.name ?? ""}」向选中的 ${selectedLeads.length} 个潜在客户批量外发邮件。批量外发不可撤回，请先确认收件人名单无误。`}
        confirmLabel="确认发送"
        pending={sending}
        error={sendError}
        onConfirm={() => void doSendCampaign()}
      />
    </RouteGuard>
  );
}
