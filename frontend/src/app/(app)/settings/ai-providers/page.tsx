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
import { KeyRound, FlaskConical, Save } from "lucide-react";

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

const USAGE_TONES: Record<string, import("@/components/shared").StatusTone> = {
  success: "success", failed: "danger", template_only: "default",
};

const USAGE_LABELS: Record<string, string> = {
  success: "成功", failed: "失败", template_only: "仅模板",
};

/* ── page ──────────────────────────────────────────────────────────────── */
export default function AiProvidersPage() {
  usePageView({ resource_id: "/settings/ai-providers" });
  const qc = useQueryClient();
  const [keys, setKeys] = useState<Record<string, string>>({});

  const { data: provData, refetch: refetchProv } = useQuery({
    queryKey: ["ai-providers"],
    queryFn: async () => (await apiClient.get<{ items: Provider[] }>("/ai/providers")).data,
  });
  const providers = provData?.items ?? [];

  const { data: taskData, refetch: refetchTasks } = useQuery({
    queryKey: ["ai-tasks"],
    queryFn: async () => (await apiClient.get<{ items: TaskMeta[] }>("/ai/tasks")).data,
  });
  const taskMeta: Record<string, TaskMeta> = Object.fromEntries(
    (taskData?.items ?? []).map((t) => [t.task_key, t]));

  const { data: bindingData, refetch: refetchBindings } = useQuery({
    queryKey: ["ai-task-bindings"],
    queryFn: async () => (await apiClient.get<{ items: TaskBinding[] }>("/ai/task-bindings")).data,
  });
  const tasks: (TaskBinding & { name: string; recommended_provider: string })[] =
    (bindingData?.items ?? []).map((b) => ({
      ...b,
      name: taskMeta[b.task_key]?.name ?? b.task_key,
      recommended_provider: taskMeta[b.task_key]?.recommended_provider ?? "",
    }));

  const { data: usageData, refetch: refetchUsage } = useQuery({
    queryKey: ["ai-usage"],
    queryFn: async () => (await apiClient.get<{ items: unknown[]; stats: UsageStat[] }>("/ai/usage")).data,
  });

  const saveKey = async (name: string) => {
    const v = keys[name] ?? "";
    try {
      await apiClient.put(`/ai/providers/${name}`, { api_key: v }); // "" clears
      toast.success(v ? `${name} 密钥已保存` : `${name} 密钥已清除`);
      setKeys({ ...keys, [name]: "" });
      refetchProv();
    } catch { toast.error("保存失败"); }
  };

  const testProvider = async (name: string) => {
    try {
      const { data } = await apiClient.post<{ ok: boolean; latency_ms: number | null; error?: string }>(
        `/ai/providers/${name}/test`);
      data.ok
        ? toast.success(`${name} 正常（${data.latency_ms} ms）`)
        : toast.error(`${name} 失败：${data.error ?? ""}`);
    } catch { toast.error("测试失败"); }
  };

  const toggleTask = async (t: TaskBinding, enabled: boolean) => {
    try {
      await apiClient.put(`/ai/task-bindings/${t.task_key}`, { enabled });
      toast.success(`${t.task_key} ${enabled ? "已启用" : "已关闭"}（${enabled ? "AI" : "模板兜底"}）`);
      refetchBindings(); refetchUsage();
    } catch { toast.error("更新失败"); }
  };

  const saveBinding = async (t: TaskBinding, patch: Partial<TaskBinding>) => {
    try {
      await apiClient.put(`/ai/task-bindings/${t.task_key}`, patch);
      refetchBindings();
    } catch { toast.error("保存失败"); }
  };

  // C27/D6：AI 配置读写全部 admin-only（后端 `_require_platform_ops` 同口径）。
  // 用 adminOnly 让非平台运营账号直连 URL 也被拦，而不是"页面能进、请求全 403"。
  return (
    <RouteGuard adminOnly>
      <PageHeader title="AI 服务商" description="自备密钥、为任务绑定服务商、审计每一次调用" />
      <div className="space-y-6 p-6">
        {/* providers */}
        <SectionCard title="服务商（用户自备密钥）">
          <p className="mb-3 text-xs text-muted-foreground">
            每个任务的优先链：绑定的服务商 → DeepSeek ↔ Kimi 互为兜底 → Zhipu → 内置模板。任务关闭 AI 也是合法配置，将始终使用模板。
          </p>
          <div className="grid gap-3 md:grid-cols-3">
            {PROVIDERS.map((name) => {
              const p = providers.find((x) => x.provider === name);
              return (
                <div key={name} className="rounded-md border p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="font-semibold capitalize">{name}</span>
                    <StatusBadge tone={p?.enabled ? "success" : "default"}>{p?.enabled ? "已启用" : "关闭"}</StatusBadge>
                  </div>
                  <div className="mb-2 text-xs text-muted-foreground">
                    密钥：{p?.api_key_masked ?? "未设置"} {p?.has_key && <Badge variant="outline">已保存</Badge>}
                  </div>
                  <div className="flex gap-1">
                    <Input type="password" placeholder="粘贴 API 密钥…" value={keys[name] ?? ""}
                      onChange={(e) => setKeys({ ...keys, [name]: e.target.value })} />
                    <Button variant="outline" size="sm" onClick={() => saveKey(name)} disabled={(keys[name] ?? "") === "" && !p?.has_key}>
                      <Save className="h-4 w-4" />
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => testProvider(name)} disabled={!p?.has_key}>
                      <FlaskConical className="h-4 w-4" />
                    </Button>
                  </div>
                  {p?.has_key && (
                    <Button className="mt-2" variant="ghost" size="sm"
                      onClick={() => { setKeys({ ...keys, [name]: "" }); apiClient.put(`/ai/providers/${name}`, { api_key: "" }).then(() => { toast.success("密钥已清除"); refetchProv(); }); }}>
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
          {tasks.length === 0 ? <EmptyState title="暂无任务" /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="p-2">任务</th><th className="p-2">AI</th><th className="p-2">服务商</th>
                    <th className="p-2">模型</th><th className="p-2">推荐</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((t) => (
                    <tr key={t.task_key} className="border-b">
                      <td className="p-2 font-medium">{t.name}<div className="text-xs text-muted-foreground">{t.task_key}</div></td>
                      <td className="p-2">
                        <label className="flex items-center gap-1">
                          <input type="checkbox" checked={t.enabled}
                            onChange={(e) => toggleTask(t, e.target.checked)} />
                          <span className="text-xs">{t.enabled ? "AI 开启" : "仅模板"}</span>
                        </label>
                      </td>
                      <td className="p-2">
                        <select className="rounded border bg-background px-2 py-1 text-xs" value={t.provider}
                          onChange={(e) => saveBinding(t, { provider: e.target.value })}>
                          {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
                        </select>
                      </td>
                      <td className="p-2">
                        <Input className="h-7 w-40 text-xs" value={t.model ?? ""}
                          onChange={(e) => saveBinding(t, { model: e.target.value })} />
                      </td>
                      <td className="p-2 text-xs text-muted-foreground">{t.recommended_provider}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        {/* usage audit */}
        <SectionCard title="用量审计" >
          <div className="mb-2">
            <Button variant="outline" size="sm" onClick={() => { refetchUsage(); refetchProv(); }}>刷新</Button>
          </div>
          {(usageData?.stats ?? []).length === 0 ? (
            <EmptyState title="暂无 AI 用量" description="每次 AI/模板调用都会在此记录 token 与费用" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="p-2">任务</th><th className="p-2">服务商</th><th className="p-2">状态</th>
                    <th className="p-2">调用次数</th><th className="p-2">提示词 token</th><th className="p-2">输出 token</th><th className="p-2">费用</th>
                  </tr>
                </thead>
                <tbody>
                  {(usageData?.stats ?? []).map((s, i) => (
                    <tr key={i} className="border-b">
                      <td className="p-2 font-medium">{s.task_key}</td>
                      <td className="p-2">{s.provider}</td>
                      <td className="p-2"><StatusBadge tone={USAGE_TONES[s.status] ?? "default"}>{USAGE_LABELS[s.status] ?? s.status}</StatusBadge></td>
                      <td className="p-2">{s.count}</td>
                      <td className="p-2">{s.prompt_tokens}</td>
                      <td className="p-2">{s.completion_tokens}</td>
                      <td className="p-2">{s.cost_usd != null ? `$${s.cost_usd.toFixed(4)}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      </div>
    </RouteGuard>
  );
}
