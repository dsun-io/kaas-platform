"use client";

/**
 * 订单货物明细的写入口（设计 §9.2 / §6.1）。
 *
 * 两条路，界面按订单状态二选一（`orderItemsEditMode`）：
 *   · pending      → `PATCH /orders/{id}` 传 `items`（整批替换，立即生效并重算总额）；
 *   · confirmed 及以后 → `POST /orders/{id}/item-change-requests`（提交变更申请，
 *     订单本身不变，管理员批准后才应用）。
 *
 * 后端错误原样透出（`handleApiError` 负责 toast）：409 `ORDER_ITEMS_LOCKED` /
 * `CHANGE_REQUEST_PENDING`、403 `NOT_APPROVER`/`SELF_APPROVAL`、422 都带 detail，
 * 组件据此展示**为什么没成功**，不自造文案。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";
import type { OrderDetail } from "@/lib/orders/order-detail";
import type {
  OrderItemChangeDecision,
  OrderItemChangeListResponse,
} from "@/lib/orders/item-change";

export const orderItemsKeys = {
  changeRequests: (orderId: number | null) =>
    ["orders", orderId ?? 0, "item-change-requests"] as const,
};

function invalidateOrder(
  qc: ReturnType<typeof useQueryClient>,
  orderId: number,
) {
  void qc.invalidateQueries({ queryKey: ["orders", orderId] });
  void qc.invalidateQueries({ queryKey: ["upstream", "orders"] });
  void qc.invalidateQueries({
    queryKey: orderItemsKeys.changeRequests(orderId),
  });
}

/**
 * 该订单的变更申请历史（含待批）。
 *
 * 降级：老后端/旧 mock 没有这条端点时**不打扰用户**（silent + retry:false），
 * 详情页只是少一个待批横幅，明细编辑入口仍按订单状态工作。
 */
export function useOrderChangeRequests(orderId: number | null) {
  return useQuery({
    queryKey: orderItemsKeys.changeRequests(orderId),
    enabled: orderId !== null,
    retry: false,
    queryFn: async () => {
      const { data } = await apiClient.get<OrderItemChangeListResponse>(
        `/orders/${orderId}/item-change-requests`,
        { silent: true },
      );
      return data;
    },
  });
}

/** pending 订单：整批替换货物行（立即生效）。 */
export function useReplaceOrderItems(orderId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (items: Record<string, unknown>[]) => {
      const { data } = await apiClient.patch<OrderDetail>(
        `/orders/${orderId}`,
        {
          items,
        },
      );
      return data;
    },
    onSuccess: () => invalidateOrder(qc, orderId),
  });
}

/** 非 pending 订单：提交明细变更申请（订单不变，等待审批）。 */
export function useCreateItemChangeRequest(orderId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      items,
      reason,
    }: {
      items: Record<string, unknown>[];
      reason: string;
    }) => {
      const { data } = await apiClient.post<
        OrderItemChangeDecision & { notified_approvers?: number[] }
      >(`/orders/${orderId}/item-change-requests`, { items, reason });
      return data;
    },
    onSuccess: () => invalidateOrder(qc, orderId),
  });
}

/** 批准 / 拒绝（内核判权：指定审批人优先、否则管理员；申请人不能自批）。 */
export function useDecideItemChangeRequest(orderId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      requestId,
      decision,
      reason,
    }: {
      requestId: number;
      decision: "approve" | "reject";
      reason?: string;
    }) => {
      // 两条 URL 写死（不用 ${decision} 拼接）：mock 覆盖率检查按字面量匹配 handler，
      // 变量段会被归一化成 */* ⇒ 明明有 mock 也会被报"未覆盖"。
      const result =
        decision === "approve"
          ? await apiClient.post<OrderItemChangeDecision>(
              `/orders/${orderId}/item-change-requests/${requestId}/approve`,
              reason ? { reason } : {},
            )
          : await apiClient.post<OrderItemChangeDecision>(
              `/orders/${orderId}/item-change-requests/${requestId}/reject`,
              reason ? { reason } : {},
            );
      return result.data;
    },
    onSuccess: () => invalidateOrder(qc, orderId),
  });
}
