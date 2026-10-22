"use client";

/**
 * 订单列表的**分页**查询（C25）+ 来源筛选（设计 §8 / §9.2）。
 *
 * 为什么不复用 `useOrderOptions()`：那个 hook 是给"报价→订单""单证→订单"这类
 * **下拉选择器**用的，固定 `page_size: 100` 且只回 `items`（丢掉 total/page）——
 * 列表页需要 total 才能画分页条，也需要能翻页；两者混用会让选择器跟着分页跳页。
 *
 * 契约（`backend/worker/src/main.py:list_orders_api`）：
 *   `page`（≥1，越界 422）/ `page_size`（1..200，越界 422）/ `status` / `q` /
 *   `customer_id` / `source_type`（inquiry|direct，非法 422）/
 *   `source_channel`（INQUIRY_CHANNEL，非法 422）/ `inquiry_id`
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
  /** 来源类型："" | "inquiry" | "direct"（空串 = 不限） */
  sourceType?: string;
  /** 渠道："" = 不限；其余必须来自渠道枚举，否则后端 422 */
  sourceChannel?: string;
  /** 只看某个询盘转化出的订单（来源链反向查） */
  inquiryId?: number | null;
}

/** 把筛选值收成"有值才传"的参数（空串不传，避免后端把 "" 当非法枚举 422）。 */
export function buildOrdersQueryParams({
  page,
  pageSize = ORDERS_PAGE_SIZE,
  status,
  q,
  sourceType,
  sourceChannel,
  inquiryId,
}: OrdersListParams): Record<string, string | number> {
  const params: Record<string, string | number> = { page, page_size: pageSize };
  if (status) params.status = status;
  if (q) params.q = q;
  if (sourceType) params.source_type = sourceType;
  if (sourceChannel) params.source_channel = sourceChannel;
  if (typeof inquiryId === "number" && inquiryId > 0) {
    params.inquiry_id = inquiryId;
  }
  return params;
}

export function useOrdersList(params: OrdersListParams) {
  const {
    page,
    pageSize = ORDERS_PAGE_SIZE,
    status,
    q,
    sourceType,
    sourceChannel,
    inquiryId,
  } = params;
  return useQuery({
    // 与 `useOrderOptions` 的 `["upstream","orders"]` 同前缀 ⇒ 建单/改条款后的
    // `invalidateQueries({queryKey:["upstream","orders"]})` 会一并刷新本列表
    queryKey: [
      "upstream",
      "orders",
      "paged",
      {
        page,
        pageSize,
        status: status ?? "",
        q: q ?? "",
        sourceType: sourceType ?? "",
        sourceChannel: sourceChannel ?? "",
        inquiryId: inquiryId ?? null,
      },
    ],
    queryFn: async () => {
      const { data } = await apiClient.get<OrdersPage>("/orders", {
        params: buildOrdersQueryParams(params),
      });
      return data;
    },
    // 翻页时保留上一页内容，避免表格闪成骨架屏（v5 的 keepPreviousData 等价写法）
    placeholderData: (previous) => previous,
  });
}
