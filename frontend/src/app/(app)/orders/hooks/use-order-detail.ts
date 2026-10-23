"use client";

/**
 * 订单详情数据层（§13.3）。
 *
 * 为什么详情单独拉：列表接口只回 14 键单头（金额/状态/条款），而详情要展示
 * 金额构成、货物明细、收款计划、实收记录与附件 —— 全在 `GET /orders/{id}` 里。
 * 查询键前缀用 `["orders", orderId]`：收款、附件、条款任何一处写成功后，
 * 失效这个前缀就能一次刷新「详情 + 收款计划 + 实收 + 附件」。
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useMutationWithError } from "./use-mutation-with-error";

import apiClient from "@/lib/api/client";
import type { OrderDetail } from "@/lib/orders/order-detail";

export const orderKeys = {
  all: ["orders"] as const,
  detail: (orderId: number) => ["orders", orderId, "detail"] as const,
};

export function useOrderDetail(orderId: number | null) {
  return useQuery({
    queryKey: orderKeys.detail(orderId ?? 0),
    enabled: orderId !== null,
    queryFn: async () => {
      const { data } = await apiClient.get<OrderDetail>(`/orders/${orderId}`);
      return data;
    },
  });
}

/** 保存贸易条款（PATCH /orders/{id}）：只发用户改过的字段。 */
export function useUpdateOrderTerms(orderId: number) {
  const qc = useQueryClient();
  return useMutationWithError({
    mutationFn: async (patch: Record<string, string>) => {
      const { data } = await apiClient.patch<OrderDetail>(
        `/orders/${orderId}`,
        patch,
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["orders", orderId] });
      qc.invalidateQueries({ queryKey: ["upstream", "orders"] });
    },
  });
}
