"use client";

/**
 * A7 单证加固的查询/变更 hooks（事实 / 一致性 / lint / 收款 / 单证清单）。
 *
 * 缓存键统一挂在 `["trade-docs", "hardening", docId, ...]` 下：
 * - 确认事实 / 改处置 / 改清单都会**同时**影响一致性（同一交易域）⇒ 一起失效；
 * - 收款 / 清单互不影响，各自失效即可（少刷一次 = 少一次闪屏）。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";
import type {
  ConsistencyResponse,
  CreateReceiptInput,
  CreateReceiptResponse,
  DocFactsResponse,
  DocSetPutInput,
  DocSetReceiptInput,
  DocSetReceiptResponse,
  DocSetResponse,
  FactPatchInput,
  FactPatchResponse,
  FactsConfirmResponse,
  LintResponse,
  ReceiptsResponse,
  VerifyExportRequest,
  VerifyExportResponse,
} from "@/lib/trade-doc/hardening";

export const hardeningKeys = {
  all: (docId: number) => ["trade-docs", "hardening", docId] as const,
  facts: (docId: number) => ["trade-docs", "hardening", docId, "facts"] as const,
  consistency: (docId: number) =>
    ["trade-docs", "hardening", docId, "consistency"] as const,
  receipts: (docId: number) =>
    ["trade-docs", "hardening", docId, "receipts"] as const,
  docSet: (docId: number) =>
    ["trade-docs", "hardening", docId, "doc-set"] as const,
};

/** 事实清单 + summary（面板顶部统计的唯一来源）。 */
export function useDocFacts(docId: number | null) {
  return useQuery({
    queryKey: hardeningKeys.facts(docId ?? 0),
    enabled: docId !== null,
    queryFn: async () => {
      const { data } = await apiClient.get<DocFactsResponse>(
        `/trade-docs/${docId}/facts`,
      );
      return data;
    },
  });
}

/** 确认事实：`keys=[]` = 全部确认（"全部确认"按钮），否则只确认勾选项。 */
export function useConfirmFacts(docId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (keys: string[]) => {
      const { data } = await apiClient.post<FactsConfirmResponse>(
        `/trade-docs/${docId}/facts/confirm`,
        { keys },
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: hardeningKeys.facts(docId) });
      // 确认事实会改变一致性/闸门结论（unverified 从 blocking 里消失）
      void qc.invalidateQueries({ queryKey: hardeningKeys.consistency(docId) });
    },
  });
}

/** 改一条事实的处置（信任级/不可改写/双语/证据）。**value 不可改**，故无该字段。 */
export function usePatchFact(docId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      factKey,
      patch,
    }: {
      factKey: string;
      patch: FactPatchInput;
    }) => {
      const { data } = await apiClient.patch<FactPatchResponse>(
        `/trade-docs/${docId}/facts/${encodeURIComponent(factKey)}`,
        patch,
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: hardeningKeys.facts(docId) });
      void qc.invalidateQueries({ queryKey: hardeningKeys.consistency(docId) });
    },
  });
}

/** 跨单证一致性（三档差异）。 */
export function useDocConsistency(docId: number | null) {
  return useQuery({
    queryKey: hardeningKeys.consistency(docId ?? 0),
    enabled: docId !== null,
    queryFn: async () => {
      const { data } = await apiClient.get<ConsistencyResponse>(
        `/trade-docs/${docId}/consistency`,
      );
      return data;
    },
  });
}

/**
 * 签发前预检（**手工触发**，不是挂载即跑）。
 *
 * 为什么用 mutation 而不是 query：它是"按钮按一下看当前结论"的动作，
 * 且后端每次都要跑四类检查（含跨单证 diff），挂载即跑会在每次打开面板时白算一遍。
 */
export function useDocLint(docId: number) {
  return useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<LintResponse>(
        `/trade-docs/${docId}/lint`,
      );
      return data;
    },
  });
}

export function useDocReceipts(docId: number | null) {
  return useQuery({
    queryKey: hardeningKeys.receipts(docId ?? 0),
    enabled: docId !== null,
    queryFn: async () => {
      const { data } = await apiClient.get<ReceiptsResponse>(
        `/trade-docs/${docId}/receipts`,
      );
      return data;
    },
  });
}

/** 登记一笔收款 → 成功后重拉列表（核销判定以后端 verdict 为准）。 */
export function useCreateReceipt(docId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateReceiptInput) => {
      const { data } = await apiClient.post<CreateReceiptResponse>(
        `/trade-docs/${docId}/receipts`,
        input,
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: hardeningKeys.receipts(docId) });
    },
  });
}

export function useDocSet(docId: number | null) {
  return useQuery({
    queryKey: hardeningKeys.docSet(docId ?? 0),
    enabled: docId !== null,
    queryFn: async () => {
      const { data } = await apiClient.get<DocSetResponse>(
        `/trade-docs/${docId}/doc-set`,
      );
      return data;
    },
  });
}

/** 全量替换清单（后端保证：仍在清单里的项保留已登记回执）。 */
export function useSaveDocSet(docId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: DocSetPutInput) => {
      const { data } = await apiClient.put<DocSetResponse>(
        `/trade-docs/${docId}/doc-set`,
        input,
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: hardeningKeys.docSet(docId) });
    },
  });
}

/** 对方出单的回执登记（receive / waive）。 */
export function useDocSetReceipt(docId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      docType,
      input,
    }: {
      docType: string;
      input: DocSetReceiptInput;
    }) => {
      const { data } = await apiClient.post<DocSetReceiptResponse>(
        `/trade-docs/${docId}/doc-set/${encodeURIComponent(docType)}/receipt`,
        input,
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: hardeningKeys.docSet(docId) });
    },
  });
}

/**
 * 导出后自检（C21）。
 *
 * **不是 query**：用户点「自检」才跑一次（要先在浏览器里用 pdf.js 抽 PDF 文本/图片数），
 * 挂载即跑会在每次打开面板时白解析一遍 PDF。
 *
 * `silent: true`：自检未通过是**业务结论**（422 `EXPORT_SELF_CHECK_FAILED`），
 * 面板会把阻断项逐条展示；不让通用错误处理再弹一个"无权限/后端繁忙"的 toast。
 */
export function useVerifyExport(docId: number) {
  return useMutation({
    mutationFn: async (body: VerifyExportRequest) => {
      const { data } = await apiClient.post<VerifyExportResponse>(
        `/trade-docs/${docId}/verify-export`,
        body,
        { silent: true },
      );
      return data;
    },
  });
}
