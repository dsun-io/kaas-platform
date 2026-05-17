"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type {
  WizardSubmitRequest,
  WizardSubmitResponse,
} from "@contracts/spec-system";

export function useWizardSubmit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: WizardSubmitRequest) => {
      const { data } = await apiClient.post<WizardSubmitResponse>(
        "/spec/wizard/submit",
        input,
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["spec", "skus"] });
    },
  });
}

export function useProposeAttribute() {
  return useMutation({
    mutationFn: async (input: {
      category_id: number;
      group_code: string;
      proposed_name: string;
      proposed_type: string;
      proposed_unit?: string | null;
      proposed_unit_group?: string | null;
      sample_values?: string[] | null;
    }) => {
      const { data } = await apiClient.post<{ id: number; status: string }>(
        "/spec/wizard/propose-attribute",
        input,
      );
      return data;
    },
  });
}
