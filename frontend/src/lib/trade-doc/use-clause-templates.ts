/**
 * 条款模板（A5-W1）数据层：`/api/v1/clause-templates` 的查询与 CRUD。
 *
 * 契约（后端并行任务，若形状变化以代码为准）：
 * - `GET /clause-templates?doc_type=` → `{items: ClauseTemplate[]}`
 * - `POST /clause-templates` body `{name,doc_types,text_zh,text_en,sort_order?}`
 * - `PATCH /clause-templates/{id}` 同 body 子集；`DELETE` 软删
 * - 读：登录即可（团队级）；写：team admin（403 由后端返回，前端只做入口禁用/如实展示）
 *
 * `silent: true`：接口可能尚未部署（并行任务未合入）时，不让通用错误 toast 抢戏；
 * 页面自己渲染「接口暂不可用」而不是假装空列表。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";

import type { ClauseTemplate, ClauseTemplateInput } from "./clause-templates";

export const clauseTemplateKeys = {
  all: ["clause-templates"] as const,
  list: (docType?: string) =>
    ["clause-templates", "list", docType ?? "all"] as const,
};

export function useClauseTemplates(
  docType?: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: clauseTemplateKeys.list(docType),
    enabled: options?.enabled ?? true,
    queryFn: async () => {
      const { data } = await apiClient.get<{ items: ClauseTemplate[] }>(
        "/clause-templates",
        {
          params: docType ? { doc_type: docType } : undefined,
          silent: true,
        },
      );
      return data.items ?? [];
    },
  });
}

export function useCreateClauseTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ClauseTemplateInput) => {
      const { data } = await apiClient.post<ClauseTemplate>(
        "/clause-templates",
        input,
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: clauseTemplateKeys.all });
    },
  });
}

export function useUpdateClauseTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...input
    }: Partial<ClauseTemplateInput> & { id: number }) => {
      const { data } = await apiClient.patch<ClauseTemplate>(
        `/clause-templates/${id}`,
        input,
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: clauseTemplateKeys.all });
    },
  });
}

export function useDeleteClauseTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await apiClient.delete(`/clause-templates/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: clauseTemplateKeys.all });
    },
  });
}
