"use client";

/**
 * 审批中心数据层（React Query）。
 *
 * 契约真源：`backend/worker/src/ws_approvals.py`（门面 `routes/approvals.ts` 原样透传）。
 *  - `GET /approvals?view=pending|mine|done&page&page_size`
 *  - `POST /orders/{id}/item-change-requests/{rid}/approve|reject`
 *  - `GET /trade-docs?order_id=`（**降级兜底**：仅当 `GET /approvals` 行里没有
 *    `affected_docs` —— 即后端 A2（0898ad69）之前的旧行 —— 才用它）
 *
 * A2 起 `GET /approvals` 的行内直接带 `affected_docs`（整页一次 IN 查完），
 * 审批详情优先用它（见 approval-detail-drawer.tsx）；否则非管理员角色查单证
 * 可能 403，会白白丢掉"已开合同可能对不上货"的提示。
 * 兜底路径里 mock 的 `GET /trade-docs` 忽略 order_id 过滤，因此**前端再按 order_id
 * 过滤一遍** —— 否则 mock 模式下会把全站单证都算成"受影响"。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";

import type {
  AffectedDoc,
  ApprovalItem,
  ApprovalListPage,
  ApprovalView,
  DecidedChangeRequest,
} from "./types";

/** 每页条数（内核 page_size 1..200，默认 20）。 */
export const APPROVALS_PAGE_SIZE = 20;
/**
 * 带 `?focus=<rid>` 深链时的页大小：通知里的待批可能不在第一页。
 * 取 100（团队待批远小于此；仍在上限 200 内），命中后按条直接打开详情。
 */
export const APPROVALS_FOCUS_PAGE_SIZE = 100;

export const approvalKeys = {
  all: ["approvals"] as const,
  list: (view: ApprovalView, page: number, pageSize: number) =>
    ["approvals", "list", view, page, pageSize] as const,
  affectedDocs: (orderId: number) =>
    ["approvals", "affected-docs", orderId] as const,
};

export interface UseApprovalsOptions {
  view: ApprovalView;
  page: number;
  pageSize?: number;
}

export function useApprovals({
  view,
  page,
  pageSize = APPROVALS_PAGE_SIZE,
}: UseApprovalsOptions) {
  return useQuery({
    queryKey: approvalKeys.list(view, page, pageSize),
    queryFn: async () => {
      const { data } = await apiClient.get<ApprovalListPage>("/approvals", {
        params: { view, page, page_size: pageSize },
      });
      return data;
    },
    // 翻页/切视图时保留上一批行，列表不闪成骨架屏（与订单列表同口径）
    placeholderData: (previous) => previous,
  });
}

export type DecideAction = "approve" | "reject";

export interface DecideChangeRequestVariables {
  orderId: number;
  requestId: number;
  action: DecideAction;
  /** 拒绝必填（后端 422 DECISION_REASON_REQUIRED）；批准可选 */
  reason?: string;
}

export function useDecideChangeRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      orderId,
      requestId,
      action,
      reason,
    }: DecideChangeRequestVariables) => {
      // 两个分支各写完整字面量路径（而不是拼 `/${action}`）：
      // mocks 覆盖率门禁按字面量抽取端点，拼出来的路径会被当成"前端未调用"。
      if (action === "reject") {
        const { data } = await apiClient.post<DecidedChangeRequest>(
          `/orders/${orderId}/item-change-requests/${requestId}/reject`,
          { reason: reason ?? "" },
          { silent: true },
        );
        return data;
      }
      const { data } = await apiClient.post<DecidedChangeRequest>(
        `/orders/${orderId}/item-change-requests/${requestId}/approve`,
        {},
        { silent: true },
      );
      return data;
    },
    onSuccess: () => {
      // 审批结果会改变待办与已处理列表；批准还会重算订单金额（另开页面时要刷新）
      void qc.invalidateQueries({ queryKey: approvalKeys.all });
      void qc.invalidateQueries({ queryKey: ["upstream", "orders"] });
      void qc.invalidateQueries({ queryKey: ["orders"] });
    },
  });
}

/** `GET /trade-docs` 行里本模块要用的最小字段（避免把单证工位的大类型拖进来）。 */
interface TradeDocLite {
  id: number;
  doc_no: string | null;
  doc_type: string;
  status: string | null;
  order_id: number | null;
}

interface TradeDocListLite {
  items?: TradeDocLite[];
  total?: number;
  page?: number;
  page_size?: number;
}

function toAffectedDoc(row: TradeDocLite): AffectedDoc {
  return {
    id: Number(row.id),
    doc_type: typeof row.doc_type === "string" ? row.doc_type : "other",
    doc_no: typeof row.doc_no === "string" ? row.doc_no : null,
    status: typeof row.status === "string" ? row.status : null,
  };
}

/**
 * 某订单已开单证 —— **旧行兜底**：仅当聚合行缺 `affected_docs`（A2 之前的后端）时调用。
 * 传 `null` 即禁用（正常情况：行内已有清单，不应再发这次请求）。
 * 失败降级为空清单 + error，由详情抽屉显示"单证清单读取失败"，绝不挡审批动作
 * （后端批准时还会再算一次并回 `affected_docs`）。
 */
export function useOrderAffectedDocs(orderId: number | null) {
  return useQuery({
    queryKey: approvalKeys.affectedDocs(orderId ?? 0),
    enabled: orderId !== null,
    queryFn: async (): Promise<AffectedDoc[]> => {
      const { data } = await apiClient.get<TradeDocListLite>("/trade-docs", {
        params: { order_id: orderId, page_size: 100 },
        silent: true,
      });
      const items = Array.isArray(data?.items) ? data.items : [];
      return items
        .filter((row) => Number(row.order_id) === Number(orderId))
        .map(toAffectedDoc)
        .filter((doc) => Number.isFinite(doc.id));
    },
    staleTime: 30_000,
  });
}

/**
 * 侧边栏「待批」角标：与审批中心「待我审批」视图**同源**（同一 queryKey 的 total）。
 *
 * 与通知铃铛的「未读数」刻意区分：
 *  - 待批 = 真正卡在流程里的申请（pending），处理后归零；
 *  - 未读 = 通知，含"已批准/已拒绝"结果通知，读到才归零。
 * page_size=1 只要 total，不拉整页；失败按 0 处理（角标缺失不能影响导航）。
 */
export function usePendingApprovalsCount(): number {
  const query = useApprovals({ view: "pending", page: 1, pageSize: 1 });
  return query.data?.total ?? 0;
}

/** 下拉"详情"用：从列表行取当前申请（列表已含新旧明细，不必再逐条请求）。 */
export function findApprovalItem(
  items: readonly ApprovalItem[],
  requestId: number | null,
): ApprovalItem | null {
  if (requestId === null) return null;
  return items.find((item) => item.id === requestId) ?? null;
}
