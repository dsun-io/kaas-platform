"use client";

/**
 * 按订单取「最早未付到期日」（应收台账的逾期判据）
 *
 * 为什么要这一步：`GET /receivables` 不返回到期日（`receivables` 表都没有 due_date），
 * 真实到期日在 `payment_schedules.due_date`（`main.py:3931` `GET /orders/{id}/payment-schedules`）。
 * 所以页面只对**当前页**的订单号并发取计划（≤20 个请求，react-query 逐订单缓存），
 * 取不到/无未付计划 ⇒ 该行「—」，**不猜测逾期**。
 *
 * 口径：一个订单可能有多期（定金/尾款），逾期以**最早一期未付**的到期日为准
 * （只要有一期过期，这单就逾期了）。已付款（`status==="paid"`）的期不参与。
 */
import { useQueries } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

export interface PaymentSchedule {
  id: number;
  order_id: number;
  schedule_type?: string | null;
  amount?: number | null;
  currency?: string | null;
  due_date?: string | null;
  actual_date?: string | null;
  status?: string | null;
}

interface SchedulePage {
  items: PaymentSchedule[];
  total: number;
}

/** 从收款计划里取「最早未付到期日」；无未付计划 → null */
export function earliestUnpaidDueOf(
  schedules: readonly PaymentSchedule[] | null | undefined,
): string | null {
  if (!Array.isArray(schedules)) return null;
  let earliest: string | null = null;
  for (const schedule of schedules) {
    if (String(schedule.status ?? "") === "paid") continue;
    const due = schedule.due_date;
    if (!due) continue;
    if (earliest === null || String(due) < earliest) earliest = String(due);
  }
  return earliest;
}

/**
 * @returns `dueByOrder`：order_id → 最早未付到期日（null = 没有未付计划/未取到）
 *          `loading`：是否还有订单在取（页面据此把逾期列显示为加载中而不是"未逾期"）
 */
export function useOrderDueDates(orderIds: readonly number[]) {
  const unique = [...new Set(orderIds.filter((id) => Number.isInteger(id) && id > 0))];
  const queries = useQueries({
    queries: unique.map((orderId) => ({
      queryKey: ["orders", orderId, "payment-schedules"] as const,
      queryFn: async () => {
        const { data } = await apiClient.get<SchedulePage>(
          `/orders/${orderId}/payment-schedules`,
          { silent: true },
        );
        return data;
      },
      // 台账页不重试：某个订单取不到不该拖慢整页；失败按"未知"展示
      retry: false,
      staleTime: 60_000,
    })),
  });

  const dueByOrder: Record<number, string | null> = {};
  unique.forEach((orderId, index) => {
    const query = queries[index];
    dueByOrder[orderId] = query?.data ? earliestUnpaidDueOf(query.data.items) : null;
  });

  return {
    dueByOrder,
    loading: queries.some((query) => query?.isLoading),
    failedCount: queries.filter((query) => query?.isError).length,
  };
}
