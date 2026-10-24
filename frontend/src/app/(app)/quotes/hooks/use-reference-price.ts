"use client";

/**
 * 历史参考价（UNCERTAIN #19 · 实时报价的回落参考）。
 *
 * 数据源 `GET /api/v1/quotes/reference-price`：同客户 + 同产品近 N 天
 * 已落库报价行项的单价聚合。报价员没有今日行情时，看这个区间决定填多少。
 * 查不到（count=0）是常态 —— 组件据此静默，不报错不打扰。
 */
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export interface ReferencePrice {
  customer_id: number;
  product_name: string;
  days: number;
  spec_matched: boolean;
  count: number;
  avg: number | null;
  min: number | null;
  max: number | null;
  median: number | null;
  last_at: string | null;
}

export function useReferencePrice(
  customerId: string | null | undefined,
  productName: string | null | undefined,
  /**
   * 产品身份（A 项 2026-10-24）：后端按行项 `spec_snapshot.product_key` 聚合，
   * 换英文名后历史价仍命中同一产品；`product_name` 保留（旧行无 product_key 时回落）。
   */
  productKey: string | null | undefined = null,
  days = 180,
) {
  return useQuery({
    queryKey: [
      "quotes",
      "reference-price",
      customerId,
      productName,
      productKey,
      days,
    ],
    queryFn: async () => {
      const { data } = await apiClient.get<ReferencePrice>(
        "/quotes/reference-price",
        {
          params: {
            customer_id: customerId,
            product_name: productName,
            product_key: productKey,
            days,
          },
        },
      );
      return data;
    },
    enabled: !!customerId && !!productName,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}
