"use client";

/**
 * 建单向导的「询盘来源」选项（设计 §3.2 / §9.2）。
 *
 * 为什么按客户过滤：询盘必须与本单客户一致（内核 422 `INQUIRY_CUSTOMER_MISMATCH`），
 * 列出别的客户的询盘只会让用户选中后再被拒。
 *
 * 契约：`GET /inquiries?customer_id=` → `{items,total}`（**无分页参数**，
 * ws_crm_ext.py:303-399 一次返回全部）；筛选变化不影响其他状态，故只在
 * 用户选了「询盘转化」时才请求（`enabled`），不白打接口。
 */
import { useQuery } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";
import type { InquiryListResponse, InquiryRow } from "@/lib/inquiries/types";

export function useInquiryOptions(
  customerId: string | null | undefined,
  enabled: boolean,
) {
  const numericId =
    customerId && /^\d+$/.test(customerId) ? Number(customerId) : null;
  return useQuery({
    queryKey: ["upstream", "inquiries", numericId],
    enabled: enabled && numericId !== null,
    retry: false,
    staleTime: 60 * 1000,
    queryFn: async () => {
      const { data } = await apiClient.get<InquiryListResponse>("/inquiries", {
        params: { customer_id: numericId },
        // 询盘接口未开通时不能让向导弹通用报错：这里只是来源选项，失败降级为
        // 「该客户暂无可选询盘」，用户仍可改为直接下单。
        silent: true,
      });
      return (data.items ?? []) as InquiryRow[];
    },
  });
}
