"use client";

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/query/keys";
import type { BindingWithAttribute } from "@contracts/spec-system";

export function useBindings(categoryId: number | null) {
  return useQuery({
    queryKey: queryKeys.spec.bindings(categoryId!),
    queryFn: async () => {
      const { data } = await apiClient.get<{ items: BindingWithAttribute[] }>(
        `/spec/categories/${categoryId}/bindings`,
      );
      return data.items;
    },
    enabled: categoryId !== null && categoryId > 0,
    staleTime: 5 * 60 * 1000,
  });
}
