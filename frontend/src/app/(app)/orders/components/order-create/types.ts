/**
 * 订单建单向导 · 共享类型与步骤定义（U-P1D2 拆分）。
 *
 * 为什么单独一份：主组件只做编排，5 个步骤组件 + 数据 hook 都消费同一份
 * `WizardApi`（状态/派生/动作）与同样的草稿类型 —— 类型分散在各步骤里会漂移
 * （比如附件草稿字段一改，上传逻辑与界面必须同时一致）。
 */
import type { Dispatch, SetStateAction } from "react";
import type { UseQueryResult } from "@tanstack/react-query";

import type { CustomerPickerValue } from "@/components/customer-picker";
import type { InquiryRow } from "@/lib/inquiries/types";
import type { OrderInfoDraft, OrderItemDraft } from "@/lib/orders/order-create";
import type { OrderSourceType } from "@/lib/orders/order-source";
import type {
  PaymentPlanRow,
  PaymentPlanValidation,
} from "@/lib/orders/payment-plan";
import type { QuoteOption } from "@/lib/workstation/use-upstream";

/** 向导五步（标题 + 顶部提示）；步骤索引就是数组下标。 */
export const WIZARD_STEPS = [
  { title: "客户与来源", hint: "订单归属到哪个客户；有报价就关联上" },
  { title: "订单信息", hint: "日期、币种、贸易条款" },
  { title: "货物与金额", hint: "明细行 + 运费/保险/其他，总额自动" },
  { title: "收款计划", hint: "按比例自动算应收" },
  { title: "附件上传", hint: "合同 / PO / 信用证扫描件" },
] as const;

/** `GET /quotes/{id}` 详情里向导要用的字段（选中报价时带出条款与货物行）。 */
export interface QuoteDetailLite {
  id: number;
  customer_id?: string | number | null;
  customer_name?: string | null;
  /** 报价的询盘来源：选中后自动把订单来源定为「询盘转化」（设计 §3.2） */
  inquiry_id?: number | null;
  currency?: string | null;
  incoterm?: string | null;
  payment_terms?: string | null;
  port_of_loading?: string | null;
  port_of_destination?: string | null;
  shipping_marks?: string | null;
  country_of_origin?: string | null;
  items?: {
    product_name?: string | null;
    qty?: number | null;
    qty_unit?: string | null;
    unit_price?: number | null;
    line_amount?: number | null;
    spec_snapshot?: Record<string, unknown> | null;
  }[];
}

/** 随单附件草稿（建单成功后逐个上传到 /orders/{id}/files）。 */
export interface PendingAttachment {
  key: string;
  file: File;
  kind: string;
  name: string;
  error: string | null;
}

/**
 * 「导入已有单证」草稿：与订单附件分开（进 external_doc_uploads 台账，
 * 不是 file_objects 随单文件）。订单创建成功后才逐条 POST /external-docs。
 */
export interface PendingExternalDoc {
  key: string;
  file: File;
  doc_type: string;
  notes: string;
  error: string | null;
}

/**
 * 向导对步骤组件暴露的全部状态/派生/动作（由 `useOrderCreateWizard` 提供）。
 *
 * 步骤组件只读它需要的字段（每个步骤在文件头摘取自己的那几项），
 * 这样主组件不用把 40+ 个 props 一层层传下去。
 */
export interface WizardApi {
  // 第 1 步：客户 / 报价 / 来源
  customer: CustomerPickerValue | null;
  setCustomer: Dispatch<SetStateAction<CustomerPickerValue | null>>;
  quoteId: string;
  chooseQuote: (nextQuoteId: string) => Promise<void>;
  quotes: UseQueryResult<QuoteOption[], Error>;
  quoteLoading: boolean;
  quoteError: string | null;
  sourceType: OrderSourceType;
  setSourceType: Dispatch<SetStateAction<OrderSourceType>>;
  inquiryId: string;
  setInquiryId: Dispatch<SetStateAction<string>>;
  channel: string;
  setChannel: Dispatch<SetStateAction<string>>;
  inquiries: UseQueryResult<InquiryRow[], Error>;
  selectedInquiry: InquiryRow | null;
  selectedQuote: QuoteOption | null;
  customerMismatch: boolean;
  setError: Dispatch<SetStateAction<string | null>>;
  // 第 2 步：订单信息
  info: OrderInfoDraft;
  setInfoField: (field: keyof OrderInfoDraft, value: string) => void;
  // 第 3 步：货物与金额
  items: OrderItemDraft[];
  setItems: Dispatch<SetStateAction<OrderItemDraft[]>>;
  addItem: () => void;
  updateItem: (key: string, patch: Partial<OrderItemDraft>) => void;
  removeItem: (key: string) => void;
  applyItems: (nextItems: OrderItemDraft[]) => void;
  freight: string;
  setFreight: Dispatch<SetStateAction<string>>;
  insurance: string;
  setInsurance: Dispatch<SetStateAction<string>>;
  other: string;
  setOther: Dispatch<SetStateAction<string>>;
  syncPlanTotal: (nextTotal: number) => void;
  goodsAmount: number;
  total: number;
  // 第 4 步：收款计划
  plan: PaymentPlanRow[];
  planTemplate: string;
  chooseTemplate: (templateId: string) => void;
  addPlanRow: () => void;
  updatePlanRow: (key: string, patch: Partial<PaymentPlanRow>) => void;
  removePlanRow: (key: string) => void;
  planValidation: PaymentPlanValidation;
  // 第 5 步：附件与已有单证
  attachments: PendingAttachment[];
  setAttachments: Dispatch<SetStateAction<PendingAttachment[]>>;
  externalDocs: PendingExternalDoc[];
  addAttachments: (fileList: FileList | null) => void;
  addExternalDocs: (fileList: FileList | null) => void;
  updateExternalDoc: (key: string, patch: Partial<PendingExternalDoc>) => void;
  removeExternalDoc: (key: string) => void;
  // 导航 / 提交（主组件外壳用）
  step: number;
  maxStep: number;
  goTo: (index: number) => void;
  goNext: () => void;
  submit: () => Promise<void>;
  creating: boolean;
  quoteIdNum: number | null;
  attachmentCount: number;
  error: string | null;
  reset: () => void;
}
