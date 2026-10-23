"use client";

/**
 * 报价单（多产品）数据层 —— 「一个询盘 → 多个产品 → 一张报价单」的读写。
 *
 * 为什么不用 `use-quotations.ts`：那是**报价记录台账**（`/api/v1/quotations`，
 * 只读账本）。报价单是另一件事：可编辑、有单号与状态、能被单证与订单引用
 * （`/api/v1/quotes`）。两者名字像，归属完全不同 —— 台账是"发生过什么"，
 * 报价单是"给客户的这张纸"。
 *
 * 保存语义：**行项整批替换**（`PUT /quotes/{id}/items`）。多产品工作台里
 * 增删改是**一次编辑动作**，逐行接口会在"改到一半失败"时留下前后不一致的报价单。
 *
 * 列表分页（P1-E）：`GET /api/v1/quotes` 本来就支持 `page` / `page_size`
 * 并回 `{items,total,page,page_size}`；旧实现写死 `page_size:50` 且忽略 total
 * ⇒ 列表永远只看得到前 50 张。现在由调用方传 page/page_size（默认 20），
 * 分页条在 `components/quote-order-records.tsx`。
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";
import { customerRecordsKeys } from "@/lib/customer/use-customer-records";
import type {
  QuoteOrder,
  QuoteOrderCreate,
  QuoteOrderItemIn,
  QuoteOrderList,
  QuoteOrderPatch,
} from "@contracts/quote-order";

import { useMutationWithError } from "./use-mutation-with-error";

const KEY = "quote-orders";

/** 报价单记录默认每页条数（与后端默认一致）。 */
export const QUOTE_ORDERS_PAGE_SIZE = 20;

/** 单张报价单详情（含行项）。 */
export function useQuoteOrder(id: number | null) {
  return useQuery({
    queryKey: [KEY, "detail", id],
    queryFn: async () => {
      const { data } = await apiClient.get<QuoteOrder>(`/quotes/${id}`);
      return data;
    },
    enabled: id !== null,
  });
}

/** 报价单列表（可按询盘/客户/状态过滤 + 分页；默认第 1 页、每页 20 张）。 */
export function useQuoteOrders(params?: {
  customer_id?: string;
  inquiry_id?: number;
  status?: string;
  page?: number;
  page_size?: number;
}) {
  const page = params?.page ?? 1;
  const pageSize = params?.page_size ?? QUOTE_ORDERS_PAGE_SIZE;
  return useQuery({
    // page 进 queryKey：翻页是不同一份数据；其余过滤条件同样入 key
    queryKey: [KEY, "list", { ...params, page, page_size: pageSize }],
    queryFn: async () => {
      const { data } = await apiClient.get<QuoteOrderList>("/quotes", {
        params: { ...params, page, page_size: pageSize },
      });
      return data;
    },
    // 翻页时保留上一页内容，避免表格闪成骨架屏（v5 的 keepPreviousData 等价写法）
    placeholderData: (previous) => previous,
  });
}

function invalidate(client: ReturnType<typeof useQueryClient>) {
  void client.invalidateQueries({ queryKey: [KEY] });
  // 报价是客户往来记录树的根：建单/改单/换行项都会改变那棵树，一并失效
  void client.invalidateQueries({ queryKey: customerRecordsKeys.all });
}

/** 新建报价单（可带多行）。空行集合也允许 —— 工作台"先建单、再逐行加产品"。 */
export function useCreateQuoteOrder() {
  const client = useQueryClient();
  return useMutationWithError({
    mutationFn: async (payload: QuoteOrderCreate) => {
      const { data } = await apiClient.post<QuoteOrder>("/quotes", payload);
      return data;
    },
    onSuccess: () => invalidate(client),
  });
}

/** 改单头 / 状态流转（draft→sent 即签发，后端会向台账补一条）。 */
export function useUpdateQuoteOrder() {
  const client = useQueryClient();
  return useMutationWithError({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: number;
      patch: QuoteOrderPatch;
    }) => {
      const { data } = await apiClient.patch<QuoteOrder>(
        `/quotes/${id}`,
        patch,
      );
      return data;
    },
    onSuccess: () => invalidate(client),
  });
}

/** 行项整批替换（工作台"保存"的语义）。 */
export function useReplaceQuoteItems() {
  const client = useQueryClient();
  return useMutationWithError({
    mutationFn: async ({
      id,
      items,
    }: {
      id: number;
      items: QuoteOrderItemIn[];
    }) => {
      const { data } = await apiClient.put<{
        id: number;
        total_amount: number | null;
        items: unknown[];
      }>(`/quotes/${id}/items`, { items });
      return data;
    },
    onSuccess: () => invalidate(client),
  });
}
