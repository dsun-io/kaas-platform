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

export interface UpdatePricingCellInput {
  /** `customer_cost_items.id`（矩阵行里的 `item_id`；只有客户配置过的行才有） */
  itemId: number;
  amount: number;
  unit?: string;
  effective_from?: string | null;
  notes?: string | null;
  status?: "active" | "inactive" | "deprecated";
}

/**
 * 改价（C36 #11）：`PATCH /api/v1/pricing-data/{item_id}`。
 *
 * 契约（`backend/worker/src/main.py:2368` `update_pricing_data`）：
 * - 只改金额/单位/生效日期/备注/状态；**改规格组合要走 POST 建新版本**；
 * - `amount <= 0`、`unit` 不在白名单、`status` 非法 ⇒ 422（该端点 422 的 `detail` 是**字符串**）；
 * - 行不存在 / 不属于当前客户 ⇒ 404。
 *
 * 为什么不像保存那样 INSERT 新版本：改错价（金额少个 0、生效期写错）应就地修正，
 * 而不是"删了重建"——重建会丢历史版本链。
 */
export function useUpdatePricingCell(productKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ itemId, ...body }: UpdatePricingCellInput) => {
      const { data } = await apiClient.patch(`/pricing-data/${itemId}`, body, {
        silent: true,
      });
      return data as {
        id: number;
        amount: number;
        unit: string;
        effective_from: string | null;
        status: string;
      };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pricing-data", productKey] });
    },
  });
}
