"use client";

/**
 * 指定审批人（D-11/D-14）数据层：`GET/PUT /api/v1/team/approvers`（仅团队管理员）。
 *
 * 为什么用 React Query 而不是 `useTeamList`（团队其它面板的写法）：
 * 审批设置是「读一份 → 本地勾选 → 整表保存」的表单，保存成功后要用
 * **PUT 的响应**回填缓存（避免再打一次 GET、也避免列表闪一下旧值）。
 * 失败仍强制降级：error 由面板显示中文文案，不抛穿页面。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";
import { normalizeApproverIds } from "@/lib/approvals/approvers";
import type {
  TeamApprover,
  TeamApproversResponse,
} from "@/lib/approvals/types";

export interface TeamApproversSnapshot {
  teamId: number | null;
  items: TeamApprover[];
  /** 空名单时谁来批（team_admins / tenant_admins），后端 "fallback" 字段 */
  fallback: string;
  /** 已保存的 user_id（升序去重），面板据此做脏检查 */
  ids: number[];
}

export const teamApproverKeys = {
  all: ["team-approvers"] as const,
  detail: () => ["team-approvers", "detail"] as const,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function asIntOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

/** 响应归一化：缺字段退化成安全默认值，坏行直接丢弃（不把坏数据塞进勾选框）。 */
export function normalizeTeamApprovers(data: unknown): TeamApproversSnapshot {
  const body = asRecord(data);
  const rawItems = Array.isArray(body?.["items"]) ? body["items"] : [];
  const items: TeamApprover[] = [];
  for (const raw of rawItems) {
    const row = asRecord(raw);
    if (!row) continue;
    const userId = asIntOrNull(row["user_id"]);
    if (userId === null || userId <= 0) continue;
    items.push({
      user_id: userId,
      display_name: asText(row["display_name"]),
      email: asText(row["email"]),
      created_by: asIntOrNull(row["created_by"]),
      created_at: asText(row["created_at"]),
    });
  }
  return {
    teamId: asIntOrNull(body?.["team_id"]),
    items,
    fallback: asText(body?.["fallback"]) ?? "team_admins",
    ids: normalizeApproverIds(items),
  };
}

export function useTeamApprovers(enabled = true) {
  return useQuery({
    queryKey: teamApproverKeys.detail(),
    enabled,
    queryFn: async () => {
      const { data } = await apiClient.get<TeamApproversResponse>(
        "/team/approvers",
        { silent: true },
      );
      return normalizeTeamApprovers(data);
    },
    staleTime: 10_000,
  });
}

export function useSaveTeamApprovers(
  /** 失败回调通道：面板已有页内 role="alert"（catch mutateAsync）；apiClient 已 toast，不重复。 */
  onMutationError?: (error: unknown) => void,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (userIds: readonly number[]) => {
      const { data } = await apiClient.put<TeamApproversResponse>(
        "/team/approvers",
        { user_ids: userIds },
        { silent: true },
      );
      return normalizeTeamApprovers(data);
    },
    onSuccess: (snapshot) => {
      // PUT 响应就是"保存后的名单"，直接回填，省一次 GET
      qc.setQueryData(teamApproverKeys.detail(), snapshot);
    },
    onError: (error) => {
      onMutationError?.(error);
    },
  });
}
