"use client";

import { apiClient } from "@/lib/api/client";
import { useSafeQuery } from "@/lib/query/safe-query";
import { CustomersResponseSchema } from "@/lib/schemas/responses";
import type { CustomersResponse } from "@/lib/schemas/responses";

export interface Customer {
  customer_id: string;
  customer_name: string;
  category_count: number;
  updated_at: string;
  locale: string;
  region: string;
}

export function useCustomers() {
  return useSafeQuery({
    queryKey: ["customers"] as const,
    queryFn: async () => {
      const { data } = await apiClient.get<CustomersResponse>("/customers");
      return data;
    },
    schema: CustomersResponseSchema,
  });
}
