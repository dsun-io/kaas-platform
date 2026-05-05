"use client";

import { keepPreviousData, useQuery, useMutation } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/query/keys";
import type {
  ProductSpecsOptions,
  QuoteV2Request,
  QuoteV2Response,
} from "@contracts/quote";

export function useProductSpecs(
  productCategory: string | null,
  filters?: {
    product_type?: string;
    wire_diameter?: string;
    height?: number;
    mesh_width?: number;
    mesh_spec?: string;
    roll_length?: number;
  },
) {
  return useQuery({
    queryKey: [
      ...queryKeys.events.list({}),
      "product-specs",
      productCategory,
      filters,
    ],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("product_category", productCategory!);
      params.set("quotable", "true");
      if (filters?.product_type)
        params.set("product_type", filters.product_type);
      if (filters?.wire_diameter)
        params.set("wire_diameter", filters.wire_diameter);
      if (filters?.height != null) params.set("height", String(filters.height));
      if (filters?.mesh_width != null)
        params.set("mesh_width", String(filters.mesh_width));
      if (filters?.mesh_spec) params.set("mesh_spec", filters.mesh_spec);
      if (filters?.roll_length != null)
        params.set("roll_length", String(filters.roll_length));
      const { data } = await apiClient.get<ProductSpecsOptions>(
        `/product-specs?${params.toString()}`,
      );
      return data;
    },
    enabled: !!productCategory,
    placeholderData: keepPreviousData,
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
