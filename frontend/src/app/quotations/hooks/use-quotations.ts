'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api/client';
import { queryKeys } from '@/lib/query/keys';

export interface Quotation {
  id: string;
  quotation_id: string;
  customer_id: string;
  product_category: string;
  product_spec: Record<string, unknown>;
  quantity: number;
  unit_price: number | null;
  status: 'matched' | 'estimated' | 'spec_not_supported';
  source: 'quotations_db' | 'L1_L2_formula' | 'manual';
  spec_hash: string;
  confidence: 'high' | 'medium' | 'low';
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

export function useQuotations(filters: QuotationFilters = {}) {
  return useQuery({
    queryKey: [...queryKeys.events.list(filters as Record<string, unknown>), 'quotations'],
    queryFn: async () => {
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([key, value]) => {
        if (value) params.set(key, value);
      });
      const query = params.toString();
      const { data } = await apiClient.get<QuotationListResponse>(
        `/quotations${query ? `?${query}` : ''}`,
      );
      return data;
    },
  });
}

export function useCreateQuotation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: Omit<Quotation, 'id' | 'quotation_id' | 'spec_hash' | 'created_at' | 'effective_from' | 'source'>) => {
      const { data } = await apiClient.post<{ id: string; spec_hash: string }>('/quotation', {
        ...input,
        source: 'manual',
      });
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quotations'] });
    },
  });
}
