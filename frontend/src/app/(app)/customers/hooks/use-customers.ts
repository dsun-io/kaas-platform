"use client";

/**
 * 客户列表/详情查询（从 page.tsx 抽出，行为不变）。
 * 列表分页参数（page/page_size）与后端 `GET /customers` 契约一致。
 */
import { useQuery } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";

import type { Customer, CustomerDetail } from "../components/customer-types";

/** 客户列表分页大小（后端 `GET /customers` 支持 page/page_size，默认 20）。 */
const CUSTOMERS_PAGE_SIZE = 20;

function useCustomerList(
  q: string | undefined,
  stage: string | undefined,
  page: number,
) {
  return useQuery({
    queryKey: ["customers", "list", q, stage, page],
    queryFn: async () => {
      const params = new URLSearchParams({
        page: String(page),
        page_size: String(CUSTOMERS_PAGE_SIZE),
      });
      if (q) params.set("q", q);
      // 后端 `GET /customers` 已支持 stage（worker main.py:1290-1310；展示值语义：
      // ordered 由开启中订单推导，active/inactive 走手动列），这里只透传，不本地过滤。
      if (stage) params.set("stage", stage);
      const { data } = await apiClient.get<{
        items: Customer[];
        total: number;
        page: number;
        page_size: number;
      }>(`/customers?${params}`);
      return data;
    },
  });
}

function useCustomerDetail(id: number | null) {
  return useQuery({
    queryKey: ["customers", "detail", id],
    queryFn: async () => {
      if (!id) return null;
      const { data } = await apiClient.get<CustomerDetail>(`/customers/${id}`);
      return data;
    },
    enabled: !!id,
  });
}

export { CUSTOMERS_PAGE_SIZE, useCustomerList, useCustomerDetail };
