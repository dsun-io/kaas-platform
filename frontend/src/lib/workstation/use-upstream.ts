"use client";

/**
 * 上游选项（订单 / 报价单 / 客户）—— 供开单时选择来源。
 *
 * 为什么单证必须有上游：单证要「继承」上游谈定的货物、金额与贸易条款。
 * 手输单号既容易错，也会绕开继承逻辑，所以这里一律用下拉选择。
 */
import { useQuery } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";

interface Paged<T> {
  items: T[];
  total: number;
}

export interface OrderOption {
  id: number;
  order_no: string;
  customer_name: string | null;
  status: string;
  currency: string;
  total_amount: number | null;
  order_date: string | null;
  delivery_date: string | null;
  incoterm: string | null;
  payment_terms: string | null;
  port_of_loading: string | null;
  port_of_destination: string | null;
  shipping_marks: string | null;
  country_of_origin: string | null;
}

export interface QuoteOption {
  id: number;
  quote_no: string;
  customer_name: string | null;
  status: string;
  currency: string;
  total_amount: number | null;
  incoterm: string | null;
}

export interface CustomerOption {
  id: number | string;
  name: string;
  country?: string | null;
}

export function useOrderOptions() {
  return useQuery({
    queryKey: ["upstream", "orders"],
    queryFn: async () => {
      const { data } = await apiClient.get<Paged<OrderOption>>("/orders", {
        params: { page_size: 100 },
      });
      return data.items;
    },
  });
}

/**
 * 报价单（`/api/v1/quotes`）是否已上线。
 *
 * ⚠️ 上线门禁（2026-09-28）：这个接口族**只在开发后端存在**，
 * Worker（线上唯一运行时）里没有 → 调用必 404。
 * 因此本次上线的版本不请求它，直接返回空列表：调用处
 * （订单「由报价单转订单」、单证开单的「报价单」上游）会自然表现为
 * "还没有报价单"，而不是弹一个 500/404。
 *
 * 放开方式：把下面改成 `false` 即可（同时按
 * `docs/CURRENT_IMPLEMENTATION_MAP.md`「上线门禁」逐步放开其余三项）。
 */
const QUOTE_ORDER_API_GATED = true;

export function useQuoteOptions() {
  return useQuery({
    // 门禁状态进 queryKey：放开后会自动重取，不需要手清缓存
    queryKey: ["upstream", "quotes", QUOTE_ORDER_API_GATED],
    queryFn: async () => {
      if (QUOTE_ORDER_API_GATED) return [] as QuoteOption[];
      const { data } = await apiClient.get<Paged<QuoteOption>>("/quotes", {
        params: { page_size: 100 },
      });
      return data.items;
    },
  });
}

export function useCustomerOptions() {
  return useQuery({
    queryKey: ["upstream", "customers"],
    queryFn: async () => {
      const { data } = await apiClient.get<Paged<CustomerOption>>(
        "/customers",
        {
          params: { page_size: 200 },
        },
      );
      return data.items;
    },
  });
}
