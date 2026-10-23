"use client";

/**
 * 「运行任务」弹窗（C36 #13 · `POST /ai/tasks/{key}/run`）
 *
 * 为什么是 **key/value** 表单而不是按 schema 生成表单
 * ------------------------------------------------
 * `GET /ai/tasks` 只返回 `{task_key,name,recommended_provider}`（`chain.py:549`），
 * **没有输入 schema**。凭空给每个任务编一套字段等于伪造契约，所以退化到最小
 * key/value：键 + 值（值先按 JSON 解析，失败按字符串），并实时显示将要发送的
 * `payload` JSON —— 用户看得见实际请求体，就不会出现"填了但没传对"。
 *
 * 结果展示（**不伪造成功**）：
 *   - 只有 200 才显示「成功」；`path=template` 说明走的是模板兜底（未启用 AI 或全挂），
 *     此时**没有** latency_ms；`note=all_providers_failed` 要额外提示"AI 全失败已退模板"。
 *   - 403/404/409 等错误原样显示 `detail.code` + `detail.detail`（含 403 需平台运营）。
 */
import { useState } from "react";
import { Loader2, Play, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

import { useRunAiTask, type AiTaskRunResult } from "../hooks/use-run-ai-task";

/** 服务商显示名（界面不展示英文技术标识；请求值仍是 deepseek/kimi/zhipu）。 */
const PROVIDER_LABELS: Record<string, string> = {
  deepseek: "DeepSeek",
  kimi: "Kimi",
  zhipu: "智谱",
};
const providerLabel = (name: string) => PROVIDER_LABELS[name] ?? name;

interface Row {
  key: string;
  value: string;
}

/** 值解析：JSON 优先（数字/布尔/对象），失败按字符串 —— 与用户直觉一致 */
export function parseRunValue(raw: string): unknown {
  const text = raw.trim();
  if (text === "") return "";
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return raw;
  }
}

/** key/value 行 → payload（空 key 忽略；同 key 后者覆盖） */
export function rowsToPayload(rows: readonly Row[]): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    payload[key] = parseRunValue(row.value);
  }
  return payload;
}

/** 后端错误 → 可读文案（403/404/409 原样透出码与文案） */
export function runErrorText(error: unknown): string {
  const anyError = error as {
    response?: { status?: number; data?: { detail?: unknown } | unknown };
    message?: string;
  };
  const status = anyError.response?.status;
  const data = anyError.response?.data;
  const detail =
    data && typeof data === "object" && "detail" in data
      ? (data as { detail?: unknown }).detail
      : undefined;
  if (detail && typeof detail === "object") {
    const obj = detail as {
      error?: unknown;
      code?: unknown;
      detail?: unknown;
      detail_text?: unknown;
    };
    const code = typeof obj.code === "string" ? obj.code : "";
    const text =
      typeof obj.detail === "string"
        ? obj.detail
        : typeof obj.detail_text === "string"
          ? obj.detail_text
          : "";
    const prefix =
      status === 403
        ? "无权限"
        : status === 404
          ? "任务不存在"
          : status === 409
            ? "冲突"
            : "";
    const body = [code, text].filter(Boolean).join("：");
    return (
      [prefix, body].filter(Boolean).join(" · ") ||
      `运行失败（状态码 ${status ?? "?"}）`
    );
  }
  if (typeof detail === "string") return detail;
  return anyError.message ?? "运行失败（网络错误）";
}

export function RunTaskDialog({
  open,
  onOpenChange,
  taskKey,
  taskName,
  onRan,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskKey: string;
  taskName: string;
  /** 运行成功后的回调（页面据此刷新用量/绑定） */
  onRan?: () => void;
}) {
  // 调用方按需卸载本弹窗（条件渲染），故无需 effect 同步 props。
  const [rows, setRows] = useState<Row[]>([{ key: "", value: "" }]);
  const [result, setResult] = useState<AiTaskRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 请求是 silent 的（拦截器不 toast），失败原因由这里落弹窗内 role=alert
  const run = useRunAiTask({
    onError: (err) => setError(runErrorText(err)),
  });

  const payload = rowsToPayload(rows);
  const payloadKeys = Object.keys(payload);

  const updateRow = (index: number, patch: Partial<Row>) =>
    setRows(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const submit = async () => {
    setError(null);
    setResult(null);
    try {
      const data = await run.mutateAsync({ taskKey, payload });
      setResult(data);
      onRan?.();
    } catch {
      // 错误文案已由 useRunAiTask 的 onError 写进 setError（含后端码/文案）
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>运行任务：{taskName}</DialogTitle>
          <DialogDescription>
            一次运行会记入调用记录。一般无需填写参数，直接运行即可；
            确需传参时展开下方「高级参数」。
          </DialogDescription>
        </DialogHeader>

        <details className="rounded-md border bg-muted/20 p-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            高级参数（一般不需要修改）
          </summary>
          <div className="mt-2 space-y-2">
            {rows.map((row, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  aria-label={`参数名 ${index + 1}`}
                  className="h-8 w-48 text-xs"
                  placeholder="参数名（如 product_name）"
                  value={row.key}
                  onChange={(e) => updateRow(index, { key: e.target.value })}
                />
                <Input
                  aria-label={`参数值 ${index + 1}`}
                  className="h-8 flex-1 text-xs"
                  placeholder='值（文本或数字，如 "Fence" / 30）'
                  value={row.value}
                  onChange={(e) => updateRow(index, { value: e.target.value })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`删除参数 ${index + 1}`}
                  disabled={rows.length === 1}
                  onClick={() => setRows(rows.filter((_, i) => i !== index))}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setRows([...rows, { key: "", value: "" }])}
            >
              <Plus className="mr-1 h-3.5 w-3.5" /> 添加参数
            </Button>
          </div>
          <div className="mt-2 border-t pt-2">
            <div className="mb-1 text-[11px] text-muted-foreground">
              参数预览
            </div>
            <pre className="max-h-32 overflow-auto text-[11px]">
              {JSON.stringify({ payload }, null, 2)}
            </pre>
            {payloadKeys.length === 0 && (
              <div className="mt-1 text-[11px] text-muted-foreground">
                未填参数时会以空内容运行（多数任务可直接运行）
              </div>
            )}
          </div>
        </details>

        {run.isPending && (
          <div
            className="flex items-center gap-2 text-xs text-muted-foreground"
            role="status"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            运行中…
          </div>
        )}

        {error && (
          <div
            className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
            role="alert"
          >
            运行失败：{error}
          </div>
        )}

        {result && (
          <div className="space-y-1 rounded-md border p-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-success-muted px-2 py-0.5 text-success-muted-foreground">
                运行成功
              </span>
              <span className="text-muted-foreground">
                执行方式：
                {result.path === "template"
                  ? "内置模板（未启用 AI）"
                  : result.path?.startsWith("ai:")
                    ? `AI 服务（${providerLabel(result.path.slice(3))}）`
                    : "AI 服务"}
              </span>
              <span className="text-muted-foreground">
                耗时：
                {typeof result.latency_ms === "number"
                  ? `${result.latency_ms} ms`
                  : "—（使用内置模板时不返回耗时）"}
              </span>
            </div>
            {result.note === "all_providers_failed" && (
              <div className="text-warning-muted-foreground">
                注意：所有 AI 服务商都未返回结果，本次由内置模板完成。
              </div>
            )}
            <details>
              <summary className="cursor-pointer text-[11px] text-muted-foreground">
                查看原始返回（一般不需要看）
              </summary>
              <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted/30 p-2 text-[11px]">
                {JSON.stringify(result.result, null, 2)}
              </pre>
            </details>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          <Button onClick={() => void submit()} disabled={run.isPending}>
            <Play className="mr-1 h-3.5 w-3.5" />
            {run.isPending ? "运行中…" : "运行"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
