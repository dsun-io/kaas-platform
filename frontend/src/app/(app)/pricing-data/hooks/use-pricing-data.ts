"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/query/keys";

export interface PricingEntry {
  id: number;
  product_category: string;
  spec_hash: string;
  spec_id: number | null;
  cost_type: string;
  amount: number;
  currency: string;
  unit: string;
  effective_from: string | null;
  effective_to: string | null;
  status: string;
  source: string;
  notes: string | null;
  created_at: string | null;
  product_spec: Record<string, unknown> | null;
}

export function usePricingData() {
  return useQuery({
    queryKey: queryKeys.pricingData.list({}),
    queryFn: async () => {
      const { data } = await apiClient.get<{ items: PricingEntry[] }>(
        "/pricing-data",
      );
      return data.items ?? [];
    },
    staleTime: 2 * 60 * 1000,
  });
}

export function useCreatePricingData() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const { data } = await apiClient.post("/pricing-data", payload);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.pricingData.list({}) });
    },
  });
}

export function useUpdatePricingData() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      payload,
    }: {
      id: number;
      payload: Record<string, unknown>;
    }) => {
      const { data } = await apiClient.patch(`/pricing-data/${id}`, payload);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.pricingData.list({}) });
    },
  });
}

export function useDeletePricingData() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await apiClient.delete(`/pricing-data/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.pricingData.list({}) });
    },
  });
}
