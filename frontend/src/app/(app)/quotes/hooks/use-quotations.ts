"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/query/keys";

import { useMutationWithError } from "./use-mutation-with-error";

export interface Quotation {
  id: string;
  quotation_id: string;
  customer_id: string;
  product_category: string;
  product_spec: Record<string, unknown>;
  quantity: number;
  unit_price: number | null;
  status: "matched" | "estimated" | "spec_not_supported";
  source: "quotations_db" | "L1_L2_formula" | "manual";
  spec_hash: string;
  confidence: "high" | "medium" | "low";
  discount: number;
  notes: string;
  effective_from: string;
  created_at: string;
}

interface QuotationListResponse {
  items: Quotation[];
  total: number;
}

export interface QuotationFilters {
  customer_id?: string;
  product_category?: string;
  spec_hash?: string;
}

/**
 * 报价列表的 queryKey。
 *
 * Q15：旧实现列表用 `["events","list",filters,"quotations"]`，而新增成功后
 * invalidate 的是 `["quotations"]` —— 两个 key 永远打不中，列表不刷新。
 * 这里把 key 收敛成一个函数，**读与失效必须同源**。
 */
export function quotationsListKey(filters: QuotationFilters = {}) {
  return [
    ...queryKeys.events.list(filters as Record<string, unknown>),
    "quotations",
  ] as const;
}

/** 所有「报价列表」查询的前缀（用于按前缀精确失效）。 */
export const QUOTATIONS_LIST_ROOT = ["events", "list"] as const;

export function useQuotations(filters: QuotationFilters = {}) {
  return useQuery({
    queryKey: quotationsListKey(filters),
    queryFn: async () => {
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([key, value]) => {
        if (value) params.set(key, value);
      });
      const query = params.toString();
      const { data } = await apiClient.get<QuotationListResponse>(
        `/quotations${query ? `?${query}` : ""}`,
      );
      return data;
    },
  });
}

export function useCreateQuotation() {
  const queryClient = useQueryClient();

  return useMutationWithError({
    mutationFn: async (
      input: Omit<
        Quotation,
        | "id"
        | "quotation_id"
        | "spec_hash"
        | "created_at"
        | "effective_from"
        | "source"
      >,
    ) => {
      const { data } = await apiClient.post<{ id: string; spec_hash: string }>(
        "/quotations",
        {
          ...input,
          source: "manual",
        },
      );
      return data;
    },
    onSuccess: () => {
      // Q15：失效**列表真实使用的 key**（`["events","list",filters,"quotations"]`）。
      // 用前缀 + predicate 覆盖任意 filters 组合，避免"录入成功但列表不刷新"。
      queryClient.invalidateQueries({
        queryKey: QUOTATIONS_LIST_ROOT,
        predicate: (query) =>
          query.queryKey[query.queryKey.length - 1] === "quotations",
      });
    },
  });
}
