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

export function useQuoteOptions() {
  return useQuery({
    queryKey: ["upstream", "quotes"],
    queryFn: async () => {
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
