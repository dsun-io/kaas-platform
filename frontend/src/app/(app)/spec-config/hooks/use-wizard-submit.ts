"use client";

import { useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type {
  WizardSubmitRequest,
  WizardSubmitResponse,
} from "@contracts/spec-system";

// 共享的「mutation + 页内错误文案」包装（本批写范围不含 src/lib/hooks；
// 后续应提升为单一实现，届时改 import 路径即可）
import { useMutationWithError } from "@/app/(app)/quotes/hooks/use-mutation-with-error";

export function useWizardSubmit() {
  const qc = useQueryClient();
  return useMutationWithError({
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
  return useMutationWithError({
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
