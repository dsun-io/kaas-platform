"use client";

/**
 * 手动运行 AI 任务（C36 #13）。
 *
 * 契约：`POST /api/v1/ai/tasks/{task_key}/run`（`backend/worker/src/chain.py:751`）
 *  - body `{payload: {…}}`（`TaskRun` 模型，payload 默认 `{}`）
 *  - 成功 200：`{result, path, task, latency_ms?, note?}`
 *    · `path` = `template` ⇒ 未启用 AI/全部服务商失败，**没有 latency_ms**（模板兜底路径不返回）
 *    · `path` = `ai:<provider>` ⇒ 带 `latency_ms`
 *    · `note` = `all_providers_failed` 表示 AI 全挂后落模板（**部分失败**，界面要如实说明）
 *  - 错误：403（`_require_platform_ops`，需平台运营）、404 `UNKNOWN_TASK`、409 冲突；
 *    错误体形状 `{detail:{error,code,detail?}}`，UI 原样透出码与文案，不吞成"运行失败"。
 */
import { useMutation } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

export interface AiTaskRunResult {
  result: unknown;
  path: string;
  task: string;
  latency_ms?: number;
  note?: string;
}

export function useRunAiTask() {
  return useMutation({
    mutationFn: async ({
      taskKey,
      payload,
    }: {
      taskKey: string;
      payload: Record<string, unknown>;
    }) => {
      const { data } = await apiClient.post<AiTaskRunResult>(
        `/ai/tasks/${encodeURIComponent(taskKey)}/run`,
        { payload },
        { silent: true },
      );
      return data;
    },
  });
}
