"use client";

/**
 * 询盘工位数据层（React Query v5）—— 列表 / 详情 / 更新 mutation。
 *
 * 契约：
 *   · `GET /api/v1/inquiries`     → `{items,total}`（**无分页参数**，内核返回全部；
 *     分页由页面在客户端切片，见 `lib/inquiries/filters.ts`）；
 *   · `GET /api/v1/inquiries/{id}` → 详情（含 quotes/orders/stage_log/counts）；
 *   · `PATCH /api/v1/inquiries/{id}` → 部分更新（channel / items / status / inquiry_no …）。
 *
 * 查询键按任务口径：列表 `["inquiries","list",filters]`、详情 `["inquiries","detail",id]`。
 * 写成功后失效 `["inquiries"]` 前缀：列表的 quote_count/order_count/阶段徽标与
 * 当前打开的详情抽屉一起刷新（否则出现「改了渠道、列表还是旧值」的假成功）。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";
import {
  toInquiryQueryParams,
  type InquiryFilters,
} from "@/lib/inquiries/filters";
import type { InquiryDetail, InquiryListResponse } from "@/lib/inquiries/types";

export const inquiryKeys = {
  all: ["inquiries"] as const,
  list: (filters: InquiryFilters) => ["inquiries", "list", filters] as const,
  detail: (inquiryId: number | null) =>
    ["inquiries", "detail", inquiryId] as const,
};

export function useInquiriesList(filters: InquiryFilters) {
  return useQuery({
    queryKey: inquiryKeys.list(filters),
    queryFn: async () => {
      const { data } = await apiClient.get<InquiryListResponse>("/inquiries", {
        params: toInquiryQueryParams(filters),
      });
      return data;
    },
    // 改筛选时保留上一批结果，表格不闪成骨架屏
    placeholderData: (previous) => previous,
  });
}

export function useInquiryDetail(inquiryId: number | null) {
  return useQuery({
    queryKey: inquiryKeys.detail(inquiryId),
    enabled: inquiryId !== null,
    queryFn: async () => {
      const { data } = await apiClient.get<InquiryDetail>(
        `/inquiries/${inquiryId}`,
      );
      return data;
    },
  });
}

export interface UpdateInquiryVariables {
  id: number;
  patch: Record<string, unknown>;
}

export function useUpdateInquiry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: UpdateInquiryVariables) => {
      const { data } = await apiClient.patch<InquiryDetail>(
        `/inquiries/${id}`,
        patch,
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: inquiryKeys.all });
    },
  });
}
