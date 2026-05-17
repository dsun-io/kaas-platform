"use client";

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/query/keys";
import type { CategoryNode } from "@contracts/spec-system";

export function useCategoryTree() {
  return useQuery({
    queryKey: queryKeys.spec.categories,
    queryFn: async () => {
      const { data } = await apiClient.get<{ items: CategoryNode[] }>(
        "/spec/categories",
      );
      return data.items;
    },
    staleTime: 10 * 60 * 1000,
  });
}

export function useCategory(categoryId: number | null) {
  return useQuery({
    queryKey: queryKeys.spec.category(categoryId!),
    queryFn: async () => {
      const { data } = await apiClient.get<CategoryNode>(
        `/spec/categories/${categoryId}`,
      );
      return data;
    },
    enabled: categoryId !== null && categoryId > 0,
    staleTime: 10 * 60 * 1000,
  });
}
