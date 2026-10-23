"use client";

import { useRef, useState } from "react";
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
import { DataTable } from "@/components/shared/data-table";
import { toast } from "sonner";
import { KeyRound, FlaskConical, Play, Save } from "lucide-react";
import { normalizeApiError } from "@/lib/api/api-error";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { RunTaskDialog } from "./components/run-task-dialog";

/* ── types ─────────────────────────────────────────────────────────────── */
interface Provider {
  provider: string;
  enabled: boolean;
  api_key_masked: string | null;
  has_key: boolean;
  base_url: string | null;
}

interface TaskMeta {
  task_key: string;
  name: string;
  recommended_provider: string;
}

interface TaskBinding {
  task_key: string;
  provider: string;
  model: string | null;
  enabled: boolean;
}

interface UsageStat {
  task_key: string;
  provider: string;
  status: string;
  count: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd?: number | null;
}

const PROVIDERS = ["deepseek", "kimi", "zhipu"];

/** 服务商显示名：界面上不出现英文技术标识（接口值仍是 deepseek/kimi/zhipu）。 */
const PROVIDER_LABELS: Record<string, string> = {
  deepseek: "DeepSeek",
  kimi: "Kimi",
  zhipu: "智谱",
};
const providerLabel = (name: string) => PROVIDER_LABELS[name] ?? name;

/**
 * 任务中文业务名：后端任务清单已带 name；这里给「用量记录」这类
 * 只回 task_key 的场景兜底，避免界面出现任务代码。
 */
const TASK_LABELS: Record<string, string> = {
  config_validation: "配置校验",
  lead_scoring: "线索评分",
  opening_line: "开场白生成",
  email_generation: "邮件生成",
  inquiry_classification: "询盘分类",
  spec_extract: "规格结构化",
  product_translate: "产品名翻译",
};
const taskLabel = (key: string) => TASK_LABELS[key] ?? "其他智能任务";

const USAGE_TONES: Record<string, import("@/components/shared").StatusTone> = {
  success: "success",
  failed: "danger",
  template_only: "default",
};

const USAGE_LABELS: Record<string, string> = {
  success: "成功",
  failed: "失败",
  template_only: "仅模板",
};

/* ── page ──────────────────────────────────────────────────────────────── */
export default function AiProvidersPage() {
  usePageView({ resource_id: "/settings/ai-providers" });
  const qc = useQueryClient();
  const [keys, setKeys] = useState<Record<string, string>>({});
  // C36 #13：运行任务弹窗（null = 关闭）
  const [runTask, setRunTask] = useState<TaskMeta | null>(null);
  // P0-B1/B4：提交中禁用 + 同 tick 连点去重（按操作 key 记账，见 begin/end）
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [savingBinding, setSavingBinding] = useState<string | null>(null);
  const [modelDrafts, setModelDrafts] = useState<Record<string, string>>({});
  // 清密钥是破坏性动作（清完该服务商的任务会掉到模板/兜底）⇒ 二次确认
  const [clearTarget, setClearTarget] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const inFlight = useRef<Set<string>>(new Set());
  const begin = (key: string) => {
    if (inFlight.current.has(key)) return false;
    inFlight.current.add(key);
    return true;
  };
  const end = (key: string) => {
    inFlight.current.delete(key);
  };

  const { data: provData, refetch: refetchProv } = useQuery({
    queryKey: ["ai-providers"],
    queryFn: async () =>
      (await apiClient.get<{ items: Provider[] }>("/ai/providers")).data,
  });
  const providers = provData?.items ?? [];

  const { data: taskData, refetch: refetchTasks } = useQuery({
    queryKey: ["ai-tasks"],
    queryFn: async () =>
      (await apiClient.get<{ items: TaskMeta[] }>("/ai/tasks")).data,
  });
  const taskMeta: Record<string, TaskMeta> = Object.fromEntries(
    (taskData?.items ?? []).map((t) => [t.task_key, t]),
  );

  const { data: bindingData, refetch: refetchBindings } = useQuery({
    queryKey: ["ai-task-bindings"],
    queryFn: async () =>
      (await apiClient.get<{ items: TaskBinding[] }>("/ai/task-bindings")).data,
  });
  const tasks: (TaskBinding & {
    name: string;
    recommended_provider: string;
  })[] = (bindingData?.items ?? []).map((b) => ({
    ...b,
    name: taskMeta[b.task_key]?.name ?? taskLabel(b.task_key),
    recommended_provider: taskMeta[b.task_key]?.recommended_provider ?? "",
  }));

  const { data: usageData, refetch: refetchUsage } = useQuery({
    queryKey: ["ai-usage"],
    queryFn: async () =>
      (
        await apiClient.get<{ items: unknown[]; stats: UsageStat[] }>(
          "/ai/usage",
        )
      ).data,
  });

  /**
   * 保存密钥。**空输入不再"顺手清密钥"**（P0-B1/C1）：
   * 以前输入框留空点保存 = PUT api_key:""，一次误点就把密钥清了、且没有确认。
   * 现在空输入时保存按钮直接禁用，清除只走「清除密钥」入口（带二次确认）。
   */
  const saveKey = async (name: string) => {
    const v = (keys[name] ?? "").trim();
    if (v === "") return;
    if (!begin(`save:${name}`)) return;
    setSavingKey(name);
    try {
      await apiClient.put(`/ai/providers/${name}`, { api_key: v });
      toast.success(`${providerLabel(name)} 密钥已保存`);
      setKeys((prev) => ({ ...prev, [name]: "" }));
      refetchProv();
    } catch (err) {
      toast.error(normalizeApiError(err).message || "保存失败");
    } finally {
      end(`save:${name}`);
      setSavingKey(null);
    }
  };

  const testProvider = async (name: string) => {
    if (!begin(`test:${name}`)) return;
    setTestingKey(name);
    try {
      const { data } = await apiClient.post<{
        ok: boolean;
        latency_ms: number | null;
        error?: string;
      }>(`/ai/providers/${name}/test`);
      if (data.ok) {
        toast.success(
          `${providerLabel(name)} 连接正常（${data.latency_ms} ms）`,
        );
      } else {
        toast.error(`${providerLabel(name)} 连接失败：${data.error ?? ""}`);
      }
    } catch {
      toast.error("测试失败");
    } finally {
      end(`test:${name}`);
      setTestingKey(null);
    }
  };

  /** 清除密钥：先弹二次确认，确认后才 PUT api_key:""（另一条清除路径同样确认）。 */
  const requestClearKey = (name: string) => {
    setClearError(null);
    setClearTarget(name);
  };

  const confirmClearKey = async () => {
    const name = clearTarget;
    if (!name || !begin(`clear:${name}`)) return;
    setClearing(true);
    setClearError(null);
    try {
      await apiClient.put(`/ai/providers/${name}`, { api_key: "" });
      toast.success(`${providerLabel(name)} 密钥已清除`);
      setKeys((prev) => ({ ...prev, [name]: "" }));
      setClearTarget(null);
      refetchProv();
    } catch (err) {
      // 失败原因留在弹窗里（弹窗不关，可直接重试或取消）
      setClearError(normalizeApiError(err).message);
    } finally {
      end(`clear:${name}`);
      setClearing(false);
    }
  };

  const toggleTask = async (t: TaskBinding, enabled: boolean) => {
    if (!begin(`toggle:${t.task_key}`)) return;
    try {
      await apiClient.put(`/ai/task-bindings/${t.task_key}`, { enabled });
      toast.success(
        `${taskLabel(t.task_key)} ${enabled ? "已启用 AI" : "已改为模板"}（${enabled ? "由 AI 生成" : "使用内置模板"}）`,
      );
      refetchBindings();
      refetchUsage();
    } catch {
      toast.error("更新失败");
    } finally {
      end(`toggle:${t.task_key}`);
    }
  };

  /**
   * 任务绑定的局部保存（服务商下拉即时保存；模型输入改为**失焦保存**，C3）。
   * 失焦保存避免每敲一个字符就打一次 PUT（旧实现 onChange 直接发请求）。
   */
  const saveBinding = async (t: TaskBinding, patch: Partial<TaskBinding>) => {
    if (!begin(`binding:${t.task_key}`)) return;
    setSavingBinding(t.task_key);
    try {
      await apiClient.put(`/ai/task-bindings/${t.task_key}`, patch);
      refetchBindings();
    } catch {
      toast.error("保存失败");
    } finally {
      end(`binding:${t.task_key}`);
      setSavingBinding(null);
    }
  };

  const commitModel = (t: TaskBinding, raw: string) => {
    const next = raw.trim();
    if (next === (t.model ?? "")) return;
    void saveBinding(t, { model: next });
  };

  // C27/D6：AI 配置读写全部 admin-only（后端 `_require_platform_ops` 同口径）。
  // 用 adminOnly 让非平台运营账号直连 URL 也被拦，而不是"页面能进、请求全 403"。
  return (
    <RouteGuard adminOnly>
      <PageHeader
        title="AI 服务商"
        description="自备密钥、为任务绑定服务商、记录每一次调用"
      />
      <div className="space-y-6 p-6">
        {/* providers */}
        <SectionCard title="服务商（用户自备密钥）">
          <p className="mb-3 text-xs text-muted-foreground">
            每个任务的优先链：绑定的服务商 → DeepSeek ↔ Kimi 互为兜底 → Zhipu →
            内置模板。任务关闭 AI 也是合法配置，将始终使用模板。
            输入框留空并保存不会清除密钥；要清除请用「清除密钥」（会二次确认）。
          </p>
          <div className="grid gap-3 md:grid-cols-3">
            {PROVIDERS.map((name) => {
              const p = providers.find((x) => x.provider === name);
              return (
                <div key={name} className="rounded-md border p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="font-semibold">{providerLabel(name)}</span>
                    <StatusBadge tone={p?.enabled ? "success" : "default"}>
                      {p?.enabled ? "已启用" : "关闭"}
                    </StatusBadge>
                  </div>
                  <div className="mb-2 text-xs text-muted-foreground">
                    服务密钥：
                    {p?.has_key ? (
                      <Badge variant="outline">已配置</Badge>
                    ) : (
                      "未配置"
                    )}
                  </div>
                  <div className="flex gap-1">
                    <Input
                      type="password"
                      placeholder="粘贴服务商密钥…"
                      value={keys[name] ?? ""}
                      onChange={(e) =>
                        setKeys({ ...keys, [name]: e.target.value })
                      }
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void saveKey(name)}
                      disabled={
                        (keys[name] ?? "").trim() === "" || savingKey === name
                      }
                      aria-label={`保存 ${providerLabel(name)}密钥`}
                      title={`保存 ${providerLabel(name)}密钥（留空不会清密钥）`}
                    >
                      <Save className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void testProvider(name)}
                      disabled={!p?.has_key || testingKey === name}
                      aria-label={`测试 ${providerLabel(name)}连接`}
                      title={`测试 ${providerLabel(name)}连接`}
                    >
                      <FlaskConical className="h-4 w-4" />
                    </Button>
                  </div>
                  {p?.has_key && (
                    <Button
                      className="mt-2"
                      variant="ghost"
                      size="sm"
                      onClick={() => requestClearKey(name)}
                      disabled={clearing && clearTarget === name}
                    >
                      <KeyRound className="mr-1 h-3 w-3" /> 清除密钥
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </SectionCard>

        {/* task bindings */}
        <SectionCard title="任务绑定">
          <DataTable
            columns={[
              {
                key: "name",
                header: "任务",
                className: "font-medium",
                render: (t) => t.name,
              },
              {
                key: "enabled",
                header: "AI",
                render: (t) => (
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={t.enabled}
                      onChange={(e) => toggleTask(t, e.target.checked)}
                    />
                    <span className="text-xs">
                      {t.enabled ? "AI 开启" : "仅模板"}
                    </span>
                  </label>
                ),
              },
              {
                key: "provider",
                header: "服务商",
                render: (t) => (
                  <select
                    className="rounded border bg-background px-2 py-1 text-xs"
                    value={t.provider}
                    onChange={(e) =>
                      saveBinding(t, { provider: e.target.value })
                    }
                  >
                    {PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {providerLabel(p)}
                      </option>
                    ))}
                  </select>
                ),
              },
              {
                key: "model",
                header: "模型",
                render: (t) => (
                  <Input
                    className="h-7 w-40 text-xs"
                    placeholder="默认模型"
                    value={modelDrafts[t.task_key] ?? t.model ?? ""}
                    disabled={savingBinding === t.task_key}
                    onChange={(e) =>
                      setModelDrafts((prev) => ({
                        ...prev,
                        [t.task_key]: e.target.value,
                      }))
                    }
                    onBlur={(e) => commitModel(t, e.target.value)}
                  />
                ),
              },
              {
                key: "recommended",
                header: "推荐",
                className: "text-xs text-muted-foreground",
                render: (t) =>
                  t.recommended_provider
                    ? providerLabel(t.recommended_provider)
                    : "—",
              },
            ]}
            rows={tasks}
            getRowKey={(t) => t.task_key}
            emptySlot={<EmptyState title="暂无任务" />}
          />
        </SectionCard>

        {/* 运行任务（C36 #13 · POST /ai/tasks/{key}/run） */}
        <SectionCard title="运行任务（调试/补跑）">
          <p className="mb-3 text-xs text-muted-foreground">
            手动运行一次任务：未启用 AI 时使用内置模板；启用后按「绑定服务商 →
            兜底」的顺序调用。
            每次运行都会记入下方调用记录；无权限或任务正在运行时会给出明确原因。
          </p>
          {(taskData?.items ?? []).length === 0 ? (
            <EmptyState title="暂无任务" />
          ) : (
            <div className="flex flex-wrap gap-2">
              {(taskData?.items ?? []).map((t) => (
                <Button
                  key={t.task_key}
                  variant="outline"
                  size="sm"
                  onClick={() => setRunTask(t)}
                >
                  <Play className="mr-1 h-3.5 w-3.5" />
                  {t.name}
                </Button>
              ))}
            </div>
          )}
        </SectionCard>

        {/* usage audit */}
        <SectionCard title="调用记录">
          <div className="mb-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                refetchUsage();
                refetchProv();
              }}
            >
              刷新
            </Button>
          </div>
          <DataTable
            columns={[
              {
                key: "task",
                header: "任务",
                className: "font-medium",
                render: (s) => taskLabel(s.task_key),
              },
              {
                key: "provider",
                header: "服务商",
                render: (s) => providerLabel(s.provider),
              },
              {
                key: "status",
                header: "状态",
                render: (s) => (
                  <StatusBadge tone={USAGE_TONES[s.status] ?? "default"}>
                    {USAGE_LABELS[s.status] ?? s.status}
                  </StatusBadge>
                ),
              },
              { key: "count", header: "调用次数", render: (s) => s.count },
              {
                key: "prompt_tokens",
                header: "用量（输入）",
                render: (s) => s.prompt_tokens,
              },
              {
                key: "completion_tokens",
                header: "用量（输出）",
                render: (s) => s.completion_tokens,
              },
              {
                key: "cost",
                header: "费用",
                render: (s) =>
                  s.cost_usd != null ? `$${s.cost_usd.toFixed(4)}` : "—",
              },
            ]}
            rows={usageData?.stats ?? []}
            getRowKey={(s) =>
              `${s.task_key}-${s.provider}-${s.status}-${s.count}`
            }
            emptySlot={
              <EmptyState
                title="暂无 AI 用量"
                description="每次 AI 或模板调用都会在此记录调用量与费用"
              />
            }
          />
        </SectionCard>
      </div>

      {runTask && (
        <RunTaskDialog
          open
          onOpenChange={(open) => {
            if (!open) setRunTask(null);
          }}
          taskKey={runTask.task_key}
          taskName={runTask.name}
          onRan={() => {
            refetchUsage();
            refetchBindings();
          }}
        />
      )}

      {/* P0-B1：清除密钥二次确认（密钥一旦清除，相关任务会立即掉到兜底/模板） */}
      <ConfirmDialog
        open={clearTarget !== null}
        onOpenChange={(open) => {
          if (!open && !clearing) {
            setClearTarget(null);
            setClearError(null);
          }
        }}
        title={`清除 ${providerLabel(clearTarget ?? "")} 的服务密钥？`}
        description="清除后该服务商不再可用；绑定到它的 AI 任务会立即回落到兜底服务商或内置模板，直到重新填写密钥。此操作不可撤销。"
        confirmLabel="确认清除"
        pending={clearing}
        error={clearError}
        onConfirm={() => void confirmClearKey()}
      />
    </RouteGuard>
  );
}
