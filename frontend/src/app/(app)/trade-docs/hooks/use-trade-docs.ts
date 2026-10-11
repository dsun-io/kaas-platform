"use client";

/**
 * 单证工位数据层
 *
 * queryKey 统一用 `["trade-docs", ...]` 前缀，便于跨页面精确失效
 * （例如在订单工位开单后，单证台账要刷新）。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";
import { customerRecordsKeys } from "@/lib/customer/use-customer-records";

export interface TradeDocSourceSnapshot {
  order_no?: string;
  quote_no?: string;
  customer_name?: string;
  currency?: string;
  total_amount?: number | null;
  incoterm?: string | null;
  payment_terms?: string | null;
  port_of_loading?: string | null;
  port_of_destination?: string | null;
  shipping_marks?: string | null;
  country_of_origin?: string | null;
  items?: Record<string, unknown>[];
}

export interface TradeDocRow {
  id: number;
  doc_no: string;
  doc_type: string;
  order_id: number | null;
  customer_id: string | null;
  status: string;
  currency: string;
  total_amount: number | null;
  issued_at: string | null;
  issued_by: string | null;
  raw_payload: {
    sources?: Record<string, TradeDocSourceSnapshot>;
    custom?: Record<string, unknown>;
  } | null;
  created_at: string | null;
}

export interface TradeDocList {
  items: TradeDocRow[];
  total: number;
  page: number;
  page_size: number;
}

export interface TradeDocRenderData {
  doc: TradeDocRow;
  /** 已装配好的渲染数据（卖方/买方/货物/条款/金额），直接交给 renderTradeDoc */
  data: Record<string, unknown>;
  company_profile_configured: boolean;
}

export interface CompanyProfile {
  name_en: string | null;
  name_zh: string | null;
  address_en: string | null;
  address_zh: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  bank_name: string | null;
  bank_account: string | null;
  swift_code: string | null;
  logo_url: string | null;
  default_incoterm: string | null;
  default_payment_terms: string | null;
  default_country_of_origin: string | null;
  configured: boolean;
  updated_at?: string | null;
}

export interface TradeDocFilters {
  doc_type?: string;
  status?: string;
  page?: number;
  page_size?: number;
}

export const tradeDocKeys = {
  all: ["trade-docs"] as const,
  list: (filters: TradeDocFilters) => ["trade-docs", "list", filters] as const,
  detail: (id: number) => ["trade-docs", "detail", id] as const,
  renderData: (id: number) => ["trade-docs", "render-data", id] as const,
  companyProfile: ["company-profile"] as const,
};

export function useTradeDocs(filters: TradeDocFilters = {}) {
  return useQuery({
    queryKey: tradeDocKeys.list(filters),
    queryFn: async () => {
      const { data } = await apiClient.get<TradeDocList>("/trade-docs", {
        params: filters,
      });
      return data;
    },
  });
}

export function useTradeDocRenderData(id: number | null) {
  return useQuery({
    queryKey: tradeDocKeys.renderData(id ?? 0),
    enabled: id !== null,
    queryFn: async () => {
      const { data } = await apiClient.get<TradeDocRenderData>(
        `/trade-docs/${id}/render-data`,
      );
      return data;
    },
  });
}

export interface CreateTradeDocInput {
  doc_type: string;
  order_id?: number | null;
  quote_order_id?: number | null;
  inquiry_id?: number | null;
  /**
   * 业务客户（外键，必填）。单证是"挂到某个客户名下的一张纸"：
   * 买方识别、客户页的往来记录树都靠它。数字 id 走 number，
   * 历史/mock 形态的非数字 id 原样传，由后端校验拒绝（不在本地造 NaN）。
   */
  customer_id?: number | string | null;
  currency?: string | null;
  raw_payload?: Record<string, unknown> | null;
}

export function useCreateTradeDoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateTradeDocInput) => {
      const { data } = await apiClient.post<TradeDocRow>("/trade-docs", input);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tradeDocKeys.all });
      // 新开一张单证 = 某个客户的「往来记录」多一个节点，跨页面一起失效，
      // 否则客户页会展示到 30s 内的旧树
      qc.invalidateQueries({ queryKey: customerRecordsKeys.all });
    },
  });
}

/** 更新手工填写内容（仅 draft 可改）或流转状态（draft → issued → void） */
export function useUpdateTradeDoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...body
    }: {
      id: number;
      status?: string;
      raw_payload?: Record<string, unknown>;
    }) => {
      const { data } = await apiClient.patch<TradeDocRow>(
        `/trade-docs/${id}`,
        body,
      );
      return data;
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: tradeDocKeys.all });
      qc.invalidateQueries({ queryKey: tradeDocKeys.detail(variables.id) });
      qc.invalidateQueries({ queryKey: tradeDocKeys.renderData(variables.id) });
    },
  });
}

/** 从上游（订单/报价）重新带入快照；仅 draft 可用，已签发单据已冻结 */
export function useRefreshSources() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const { data } = await apiClient.post<{
        doc: TradeDocRow;
        sources: string[];
      }>(`/trade-docs/${id}/refresh-sources`);
      return data;
    },
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: tradeDocKeys.all });
      qc.invalidateQueries({ queryKey: tradeDocKeys.renderData(id) });
    },
  });
}

export function useCompanyProfile() {
  return useQuery({
    queryKey: tradeDocKeys.companyProfile,
    queryFn: async () => {
      const { data } = await apiClient.get<CompanyProfile>(
        "/tenant/company-profile",
      );
      return data;
    },
  });
}

export function useSaveCompanyProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: Partial<CompanyProfile> & { name_en: string },
    ) => {
      const { data } = await apiClient.put<CompanyProfile>(
        "/tenant/company-profile",
        input,
      );
      return data;
    },
    onSuccess: () => {
      // 企业信息变了 → 所有单据的抬头都变了，必须整体失效
      qc.invalidateQueries({ queryKey: tradeDocKeys.companyProfile });
      qc.invalidateQueries({ queryKey: tradeDocKeys.all });
    },
  });
}

/** 业务枚举字典（不变量 11：前后端共用同一份合法值，前端不得硬编码另一份） */
export function useEnum(
  name:
    | "doc_type"
    | "doc_status"
    | "currency"
    | "order_status"
    | "quote_status"
    | "shipment_status",
) {
  return useQuery({
    queryKey: ["enums", name],
    staleTime: 30 * 60 * 1000,
    queryFn: async () => {
      const { data } = await apiClient.get<Record<string, string[]>>("/enums");
      return data[name] ?? [];
    },
  });
}
