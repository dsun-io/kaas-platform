"use client";

/**
 * 开单前「完整成品预览」数据层（2026-10-24，用户需求 1）。
 *
 * 用户原话：「在正式生成单证之前我需要完整预览单证」—— 不再是样板占位，
 * 要真实货物/金额/条款。走内核**只读**端点
 * `POST /trade-docs/preview-render-data`：入参与开单 `POST /trade-docs` 同形状（单张），
 * 返回的 `data` 与已落库单据 `GET /trade-docs/{id}/render-data` **同源同形状**
 * （买方/卖方/银行/贸易条款/货物行项/金额都由内核按上游装配）。
 *
 * 为什么单独一个文件、由对话框按需挂载：
 * - 预览是对话框内的临时查询：页面/表单不打开对话框时**一个请求都不发**
 *   （该端点每次都要读库装配，不能随表单渲染白跑一遍）；
 * - 多选类型逐类切换时按「入参」做查询键，来回切换命中缓存、不重复请求；
 * - **预览不写库**：这里只 POST 这一个只读端点，绝不复用 `useCreateTradeDoc`。
 *   边界说明见 `components/doc-create-preview.tsx`。
 */
import { useQuery } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";

/** 请求体 = 开单 `POST /trade-docs` 同形状（单张类型）。 */
export interface PreviewRenderDataRequest {
  doc_type: string;
  customer_id: number | string;
  currency?: string | null;
  with_seal?: boolean;
  order_id?: number | null;
  quote_order_id?: number | null;
  inquiry_id?: number | null;
}

/**
 * 预览阶段的**虚拟单据**元信息。
 *
 * 预览不落库 ⇒ 没有 id、没有正式单号；这些字段可能为 null，
 * 前端只能用来标示「开单后会生成」，不能当真实单号展示。
 */
export interface PreviewRenderDoc {
  id?: number | null;
  doc_no?: string | null;
  doc_type?: string | null;
  status?: string | null;
  currency?: string | null;
  total_amount?: number | null;
  created_at?: string | null;
}

/** 响应 = `{doc, data, company_profile_configured}`，与 render-data 同形状。 */
export interface PreviewRenderData {
  doc: PreviewRenderDoc;
  /** 直接交给 `renderTradeDoc(doc_type, data)` */
  data: Record<string, unknown>;
  /** 企业信息（卖方抬头/银行）是否已配置；false 时单据上的卖方块会是空的 */
  company_profile_configured: boolean;
}

/** 查询键：入参变了（客户/币种/上游/盖章/类型）就重新取，未变则看缓存。 */
export function previewRenderDataKey(request: PreviewRenderDataRequest) {
  return ["trade-docs", "preview-render-data", request] as const;
}

/**
 * 拉取单张类型的**完整**预览数据。
 *
 * - `retry: false`：失败就如实报错（对话框显示明确原因 + 重试按钮），
 *   不靠自动重试掩盖后端问题，也**不退回样板数据冒充完整预览**；
 * - `staleTime` 1 分钟：对话框内来回切换类型时不重复打同一个请求
 *   （表单值改了会改变查询键，仍会重新取）。
 */
export function usePreviewRenderData(request: PreviewRenderDataRequest) {
  return useQuery({
    queryKey: previewRenderDataKey(request),
    queryFn: async () => {
      const { data } = await apiClient.post<PreviewRenderData>(
        "/trade-docs/preview-render-data",
        request,
        // 失败由对话框自己渲染明确错误态，不额外弹全局 toast
        { silent: true },
      );
      return data;
    },
    retry: false,
    staleTime: 60_000,
  });
}
