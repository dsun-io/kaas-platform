"use client";

/**
 * 订单列表的**分页**查询（C25）。
 *
 * 为什么不复用 `useOrderOptions()`：那个 hook 是给"报价→订单""单证→订单"这类
 * **下拉选择器**用的，固定 `page_size: 100` 且只回 `items`（丢掉 total/page）——
 * 列表页需要 total 才能画分页条，也需要能翻页；两者混用会让选择器跟着分页跳页。
 *
 * 契约（`backend/worker/src/main.py:list_orders_api`）：
 *   `page`（≥1，越界 422）/ `page_size`（1..200，越界 422）/ `status` / `q`
 *   → `{items, total, page, page_size}`（**没有 has_more**，总页数由 total 推）
 */
import { useQuery } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";
import type { OrderOption } from "@/lib/workstation/use-upstream";

export const ORDERS_PAGE_SIZE = 20;

export interface OrdersPage {
  items: OrderOption[];
  total: number;
  page: number;
  page_size: number;
}

export interface OrdersListParams {
  page: number;
  pageSize?: number;
  status?: string;
  q?: string;
}

export function useOrdersList({
  page,
  pageSize = ORDERS_PAGE_SIZE,
  status,
  q,
}: OrdersListParams) {
  return useQuery({
    // 与 `useOrderOptions` 的 `["upstream","orders"]` 同前缀 ⇒ 建单/改条款后的
    // `invalidateQueries({queryKey:["upstream","orders"]})` 会一并刷新本列表
    queryKey: ["upstream", "orders", "paged", { page, pageSize, status: status ?? "", q: q ?? "" }],
    queryFn: async () => {
      const { data } = await apiClient.get<OrdersPage>("/orders", {
        params: {
          page,
          page_size: pageSize,
          ...(status ? { status } : {}),
          ...(q ? { q } : {}),
        },
      });
      return data;
    },
    // 翻页时保留上一页内容，避免表格闪成骨架屏（v5 的 keepPreviousData 等价写法）
    placeholderData: (previous) => previous,
  });
}
