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
import { KeyRound, FlaskConical, Play, Save } from "lucide-react";
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

  const saveKey = async (name: string) => {
    const v = keys[name] ?? "";
    try {
      await apiClient.put(`/ai/providers/${name}`, { api_key: v }); // "" clears
      toast.success(
        v
          ? `${providerLabel(name)} 密钥已保存`
          : `${providerLabel(name)} 密钥已清除`,
      );
      setKeys({ ...keys, [name]: "" });
      refetchProv();
    } catch {
      toast.error("保存失败");
    }
  };

  const testProvider = async (name: string) => {
    try {
      const { data } = await apiClient.post<{
        ok: boolean;
        latency_ms: number | null;
        error?: string;
      }>(`/ai/providers/${name}/test`);
      data.ok
        ? toast.success(`${providerLabel(name)} 连接正常（${data.latency_ms} ms）`)
        : toast.error(`${providerLabel(name)} 连接失败：${data.error ?? ""}`);
    } catch {
      toast.error("测试失败");
    }
  };

  const toggleTask = async (t: TaskBinding, enabled: boolean) => {
    try {
      await apiClient.put(`/ai/task-bindings/${t.task_key}`, { enabled });
      toast.success(
        `${taskLabel(t.task_key)} ${enabled ? "已启用 AI" : "已改为模板"}（${enabled ? "由 AI 生成" : "使用内置模板"}）`,
      );
      refetchBindings();
      refetchUsage();
    } catch {
      toast.error("更新失败");
    }
  };

  const saveBinding = async (t: TaskBinding, patch: Partial<TaskBinding>) => {
    try {
      await apiClient.put(`/ai/task-bindings/${t.task_key}`, patch);
      refetchBindings();
    } catch {
      toast.error("保存失败");
    }
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
                      onClick={() => saveKey(name)}
                      disabled={(keys[name] ?? "") === "" && !p?.has_key}
                      aria-label={`保存 ${providerLabel(name)}密钥`}
                      title={`保存 ${providerLabel(name)}密钥`}
                    >
                      <Save className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => testProvider(name)}
                      disabled={!p?.has_key}
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
                      onClick={() => {
                        setKeys({ ...keys, [name]: "" });
                        apiClient
                          .put(`/ai/providers/${name}`, { api_key: "" })
                          .then(() => {
                            toast.success("密钥已清除");
                            refetchProv();
                          });
                      }}
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
          {tasks.length === 0 ? (
            <EmptyState title="暂无任务" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th scope="col" className="p-2">
                      任务
                    </th>
                    <th scope="col" className="p-2">
                      AI
                    </th>
                    <th scope="col" className="p-2">
                      服务商
                    </th>
                    <th scope="col" className="p-2">
                      模型
                    </th>
                    <th scope="col" className="p-2">
                      推荐
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((t) => (
                    <tr key={t.task_key} className="border-b">
                      <td className="p-2 font-medium">{t.name}</td>
                      <td className="p-2">
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
                      </td>
                      <td className="p-2">
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
                      </td>
                      <td className="p-2">
                        <Input
                          className="h-7 w-40 text-xs"
                          value={t.model ?? ""}
                          onChange={(e) =>
                            saveBinding(t, { model: e.target.value })
                          }
                        />
                      </td>
                      <td className="p-2 text-xs text-muted-foreground">
                        {t.recommended_provider
                          ? providerLabel(t.recommended_provider)
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        {/* 运行任务（C36 #13 · POST /ai/tasks/{key}/run） */}
        <SectionCard title="运行任务（调试/补跑）">
          <p className="mb-3 text-xs text-muted-foreground">
            手动运行一次任务：未启用 AI 时使用内置模板；启用后按「绑定服务商 → 兜底」的顺序调用。
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
          {(usageData?.stats ?? []).length === 0 ? (
            <EmptyState
              title="暂无 AI 用量"
              description="每次 AI 或模板调用都会在此记录调用量与费用"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th scope="col" className="p-2">
                      任务
                    </th>
                    <th scope="col" className="p-2">
                      服务商
                    </th>
                    <th scope="col" className="p-2">
                      状态
                    </th>
                    <th scope="col" className="p-2">
                      调用次数
                    </th>
                    <th scope="col" className="p-2">
                      用量（输入）
                    </th>
                    <th scope="col" className="p-2">
                      用量（输出）
                    </th>
                    <th scope="col" className="p-2">
                      费用
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(usageData?.stats ?? []).map((s, i) => (
                    <tr key={i} className="border-b">
                      <td className="p-2 font-medium">
                        {taskLabel(s.task_key)}
                      </td>
                      <td className="p-2">{providerLabel(s.provider)}</td>
                      <td className="p-2">
                        <StatusBadge tone={USAGE_TONES[s.status] ?? "default"}>
                          {USAGE_LABELS[s.status] ?? s.status}
                        </StatusBadge>
                      </td>
                      <td className="p-2">{s.count}</td>
                      <td className="p-2">{s.prompt_tokens}</td>
                      <td className="p-2">{s.completion_tokens}</td>
                      <td className="p-2">
                        {s.cost_usd != null ? `$${s.cost_usd.toFixed(4)}` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
    </RouteGuard>
  );
}
