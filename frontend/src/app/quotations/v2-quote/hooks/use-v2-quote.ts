"use client";

import { useQuery, useMutation } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/query/keys";
import type {
  ProductSpecsOptions,
  QuoteV2Request,
  QuoteV2Response,
} from "@contracts/quote";

export function useProductSpecs(productCategory: string | null) {
  return useQuery({
    queryKey: [...queryKeys.events.list({}), "product-specs", productCategory],
    queryFn: async () => {
      const { data } = await apiClient.get<ProductSpecsOptions>(
        `/product-specs?product_category=${encodeURIComponent(productCategory!)}`,
      );
      return data;
    },
    enabled: !!productCategory,
    staleTime: 5 * 60 * 1000,
  });
}

export function useQuoteV2() {
  return useMutation({
    mutationFn: async (input: QuoteV2Request) => {
      const { data } = await apiClient.post<QuoteV2Response>("/quote", input);
      return data;
    },
  });
}
