"use client";

/**
 * 客户「往来记录」查询 —— 读 `GET /customers/{id}/records`（设计文档 §3）。
 *
 * 降级策略（本模块存在的理由）：
 *   这个接口可能**还没上线**。任何失败（404 / 网络断 / 返回体不是那份结构）
 *   都在 queryFn 内部被吞掉，返回 `{ ok: false }`，而不是把异常抛给 React ——
 *   客户详情页是主流程页面，一块附加信息不许把整页打成错误边界或白屏。
 *   组件据此渲染"暂无往来记录 / 加载失败（可重试）"。
 *
 * 不做自动重试：接口不存在时重试只会让用户多等三次，还会刷三条错误提示。
 */
import { useQuery } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";
import {
  EMPTY_CUSTOMER_RECORDS,
  normalizeCustomerRecords,
  type CustomerRecords,
} from "./customer-records";

export interface CustomerRecordsResult {
  /** false = 这次没读到（接口缺失/失败），树为空是"加载失败"而不是"没有记录" */
  ok: boolean;
  records: CustomerRecords;
}

export const customerRecordsKeys = {
  all: ["customer-records"] as const,
  detail: (customerId: number | string) =>
    ["customer-records", "detail", String(customerId)] as const,
};

export function useCustomerRecords(customerId: number | null) {
  return useQuery({
    queryKey: customerRecordsKeys.detail(customerId ?? 0),
    enabled: customerId !== null,
    retry: false,
    staleTime: 30 * 1000,
    queryFn: async (): Promise<CustomerRecordsResult> => {
      try {
        const { data } = await apiClient.get<unknown>(
          `/customers/${customerId}/records`,
        );
        return { ok: true, records: normalizeCustomerRecords(data) };
      } catch {
        // 刻意不 rethrow：接口尚未实现属于"预期内"，由 UI 走降级分支
        return { ok: false, records: EMPTY_CUSTOMER_RECORDS };
      }
    },
  });
}
