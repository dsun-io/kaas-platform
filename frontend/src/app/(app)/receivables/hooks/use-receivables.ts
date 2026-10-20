"use client";

/**
 * 应收台账数据（C36 下期 #7）
 *
 * 契约：`GET /api/v1/receivables`（`main.py:4090`）
 *   - `status` 服务端过滤（unpaid|partial|paid；非法 422 `bad_receivable_status`）
 *   - `page`（ge=1）/`page_size`（1..200，越界 422）
 *   - 返回 `{items,total,page,page_size}`（行 = 12 键 + order_no/customer_name）
 *
 * 到期日不在应收接口里：见 `use-order-due-dates.ts`（按订单取 payment-schedules）。
 */
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type {
  ReceivablePage,
  ReceivableRow,
  ReceivableStatus,
} from "@/lib/receivables/summary";

export const RECEIVABLES_PAGE_SIZE = 20;
/** 汇总窗口：一次取服务端允许的最大页（200），超出部分在界面写明"未计入" */
export const RECEIVABLES_SUMMARY_WINDOW = 200;

export function useReceivables({
  page,
  pageSize = RECEIVABLES_PAGE_SIZE,
  status,
}: {
  page: number;
  pageSize?: number;
  status: ReceivableStatus | "all";
}) {
  return useQuery({
    queryKey: ["receivables", "list", { page, pageSize, status }],
    queryFn: async () => {
      const { data } = await apiClient.get<ReceivablePage>("/receivables", {
        params: {
          page,
          page_size: pageSize,
          ...(status !== "all" ? { status } : {}),
        },
      });
      return data;
    },
    placeholderData: (previous) => previous,
  });
}

/**
 * 汇总窗口（≤200 条，同一 `status` 过滤）。
 *
 * 单独一次请求是为了让「总额/已收/未收」不随分页跳动 —— 与列表共用同一个
 * `status` 条件，页面会标注"按最新 200 条汇总"。
 */
export function useReceivablesSummaryWindow({
  status,
}: {
  status: ReceivableStatus | "all";
}) {
  return useQuery({
    queryKey: ["receivables", "summary", { status }],
    queryFn: async () => {
      const { data } = await apiClient.get<ReceivablePage>("/receivables", {
        params: {
          page: 1,
          page_size: RECEIVABLES_SUMMARY_WINDOW,
          ...(status !== "all" ? { status } : {}),
        },
      });
      return data;
    },
    placeholderData: (previous) => previous,
  });
}

/** 从页面上直接读某一行的 `order_id`（0/空 → null，不误发请求） */
export function orderIdOf(row: ReceivableRow): number | null {
  const id = Number(row.order_id);
  return Number.isInteger(id) && id > 0 ? id : null;
}
