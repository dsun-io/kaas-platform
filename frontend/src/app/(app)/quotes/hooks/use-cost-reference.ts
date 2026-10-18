"use client";

/**
 * 产品成本参考值（需求 11）。
 *
 * 口径：同产品 + 同规格最近一次 → 近 30 天中位数 → 无参考。
 * 指纹由后端按原始规格算（前端不抄一份哈希算法，避免两端漂移）。
 */
import { useQuery } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";

export interface CostReference {
  cost: number;
  cost_unit?: string;
  source: "latest" | "median_30d";
  sample_count: number;
  as_of: string | null;
  quote_no?: string;
  spec_snapshot?: Record<string, unknown>;
}

export function useProductCostReference(
  productKey: string,
  spec: Record<string, unknown>,
  enabled = true,
) {
  const specReady = enabled && !!productKey && Object.keys(spec).length > 0;
  return useQuery({
    queryKey: ["quote-cost-reference", productKey, spec],
    enabled: specReady,
    staleTime: 60_000,
    queryFn: async () => {
      const { data } = await apiClient.get<{
        reference: CostReference | null;
      }>("/quotes/cost-reference", {
        params: {
          product_key: productKey,
          spec: JSON.stringify(spec),
        },
      });
      return data.reference;
    },
  });
}
