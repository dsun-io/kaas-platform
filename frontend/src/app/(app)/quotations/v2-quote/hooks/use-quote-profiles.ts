"use client";

/**
 * 客户税率档案的接线。
 *
 * 一句话说明它是什么：**报价页那个「税务档案」下拉里的客户那一层**。
 * 上层是平台维护的法定税率（国家政策），这一层是这个客户自己填的那套
 * （进项票税点 / 销项税率 / 出口退税率 / 印花税率 + 基数），存成命名档案复用。
 *
 * 为什么它不需要引擎配合：套用档案做的事就是**把表单填好**，与用户手敲一遍的
 * 结果逐字段相同。引擎收到的仍然是「rate_set_code + policy 覆盖」。这条约束很值钱 ——
 * 它保证「用档案算出来的价」与「手填算出来的价」不可能分叉。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { EXPORT_QUOTE_BASE } from "@/lib/export-quote/import-file";
import type {
  QuoteProfile,
  QuoteProfileList,
  QuoteProfileTax,
  SaveQuoteProfile,
} from "@contracts/export-quote";

const KEY = "quote-profiles";

/**
 * 某产品下当前客户可用的税率档案。
 *
 * 后端固定按创建时间倒序返回，新的在前 —— 「默认选最新创建的」取第一条即可。
 */
export function useQuoteProfiles(productKey: string | null) {
  return useQuery({
    queryKey: [KEY, productKey],
    enabled: !!productKey,
    queryFn: async () => {
      const { data } = await apiClient.get<QuoteProfileList>(
        `${EXPORT_QUOTE_BASE}/quote-profiles`,
        { params: { product_key: productKey } },
      );
      return data;
    },
    staleTime: 60 * 1000,
  });
}

/** 保存一份新档案。 */
export function useSaveQuoteProfile(productKey: string) {
  const qc = useQueryClient();
  return useMutation<QuoteProfile, unknown, SaveQuoteProfile>({
    mutationFn: async (payload) => {
      const { data } = await apiClient.post<QuoteProfile>(
        `${EXPORT_QUOTE_BASE}/quote-profiles`,
        payload,
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY, productKey] });
    },
  });
}

/** 改名或覆盖内容。 */
export function useUpdateQuoteProfile(productKey: string) {
  const qc = useQueryClient();
  return useMutation<
    QuoteProfile,
    unknown,
    { id: number; profile_name?: string; tax_overrides?: QuoteProfileTax }
  >({
    mutationFn: async ({ id, ...patch }) => {
      const { data } = await apiClient.patch<QuoteProfile>(
        `${EXPORT_QUOTE_BASE}/quote-profiles/${id}`,
        patch,
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY, productKey] });
    },
  });
}

/**
 * 停用一份档案（后端软删，行留在库里）。
 *
 * 软删而非硬删：档案一旦生成过报价单，删掉就无法回答「当时用的是哪套税率」。
 */
export function useDeleteQuoteProfile(productKey: string) {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean; id: number }, unknown, number>({
    mutationFn: async (id) => {
      const { data } = await apiClient.delete<{ ok: boolean; id: number }>(
        `${EXPORT_QUOTE_BASE}/quote-profiles/${id}`,
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY, productKey] });
    },
  });
}
