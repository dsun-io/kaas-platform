"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { PricingMatrix, SavePricingCell } from "@contracts/export-quote";

/**
 * 客户定价数据（成本表）。
 *
 * 界面拿到的是产品定价键的**完整矩阵**：客户配过的显示配置值，没配过的显示
 * 产品定义的兜底值（configured=false）。所以表格永远完整，可以直接对照着报价，
 * 不会出现「界面上没这一行、报价里却在用这个价」。
 */
export function usePricingMatrix(
  productKey: string,
  scope: "own" | "all" = "own",
) {
  return useQuery({
    queryKey: ["pricing-data", productKey, scope],
    enabled: !!productKey,
    queryFn: async () => {
      const { data } = await apiClient.get<PricingMatrix>("/pricing-data", {
        params: { product_key: productKey, scope },
      });
      return data;
    },
    staleTime: 60 * 1000,
  });
}

/** 保存某一格成本（后端 INSERT 新版本并停用旧版本，历史可追溯）。 */
export function useSavePricingCell(productKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: SavePricingCell) => {
      const { data } = await apiClient.post("/pricing-data", payload);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pricing-data", productKey] });
    },
  });
}

/** 停用某一格的自定义成本 → 回退到产品定义的兜底值。 */
export function useDeactivatePricingCell(productKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (itemId: number) => {
      await apiClient.delete(`/pricing-data/${itemId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pricing-data", productKey] });
    },
  });
}
