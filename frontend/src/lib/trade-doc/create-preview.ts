/**
 * 开单前「成品预览」的数据装配 —— **纯前端、零网络、零写入**。
 *
 * 为什么需要这一层
 * ----------------
 * 正式预览（已落库单据）走 `GET /trade-docs/{id}/render-data`：后端按快照把它装配成
 * `renderTradeDoc(docType, data)` 需要的形状（见 page.tsx 的 useTradeDocRenderData）。
 * 开单**之前**还没有 id，也就没有这条通路；但用户仍想先看一眼「这单开出来长什么样」。
 *
 * 所以这里做的是「样板底稿 + 当前表单已填值」的最小叠加：
 *   · 底稿 = 内置 `sample-data.json`（仓库里本来就用于样板预览，不写库）；
 *   · 覆盖 = 表单里**确实已经有值**的三类字段：币种、业务客户（买方公司名）、
 *     已选上游（订单/报价单）的贸易条款；
 *   · 其余字段（货物明细、单号、日期、地址……）开单后才由系统带入 ⇒ **保留样板占位值**，
 *     由对话框里的说明与「成品预览」的定位（只看版式与已填内容）如实告知。
 *
 * 边界（刻意不做的事）
 * --------------------
 * - **不复制内核装配规则**：不在这里算卖方/买方块、不传播 consignee/insured、不派生金额。
 *   那些是 `kaas_common.trade_doc.payload_shared.build_render_data` 的职责（业务规则只在
 *   Python 内核实现）；前端只做「已填值的搬运」，保证预览不会和落库后的真单据漂移成两套算法。
 * - **不调用后端**：预览不允许写库，也不依赖任何接口（后端没起也能看）。
 * - 不修改 `sample-data.json`：它同时是 18 类单据逐字节回归基线的输入。
 */
import type { OrderOption, QuoteOption } from "@/lib/workstation/use-upstream";

import sampleData from "./sample-data.json";

const SAMPLE = sampleData as unknown as {
  base: Record<string, unknown>;
  other_extra?: Record<string, unknown>;
};

/**
 * 与内核 `kaas_common.trade_doc.payload_shared.TRADE_TERM_FIELDS` 同名同序
 * （同一组「贸易条款」字段：开单时从上游继承）。
 */
const TRADE_TERM_FIELDS = [
  "incoterm",
  "payment_terms",
  "port_of_loading",
  "port_of_destination",
  "shipping_marks",
  "country_of_origin",
] as const;

type TradeTermField = (typeof TRADE_TERM_FIELDS)[number];

/** 表单里能提供的字段（订单选项有全套；报价单选项只有 incoterm） */
export type CreatePreviewUpstream = Partial<Pick<OrderOption, TradeTermField>> &
  Partial<Pick<QuoteOption, "incoterm">>;

export interface CreatePreviewInput {
  /** 要预览的单证类型（必填；无类型返回 null） */
  docType: string;
  /** 币种（表单里的币种输入框，提交时也用它） */
  currency?: string | null;
  /** 业务客户名（表单必选项；作为单据买方公司名） */
  customerName?: string | null;
  /** 已选上游（订单/报价单）；没选则不覆盖任何条款 */
  upstream?: CreatePreviewUpstream | null;
}

export interface CreatePreview {
  docType: string;
  /** 直接交给 `renderTradeDoc(docType, data)`；与后端 render-data 的 data 同形状 */
  data: Record<string, unknown>;
  /** 本次**真正取自当前表单**的字段（中文名，用于在对话框里如实说明数据来源） */
  fromForm: string[];
}

/** 贸易条款字段 → 中文名（对话框里如实说明「哪些值来自当前表单」） */
const TRADE_TERM_LABELS: Record<TradeTermField, string> = {
  incoterm: "贸易术语",
  payment_terms: "付款方式",
  port_of_loading: "装运港",
  port_of_destination: "目的港",
  shipping_marks: "唛头",
  country_of_origin: "原产国",
};

/** 只覆盖「有值」的条款：空值不能把样板底稿冲成空串（否则预览反而比底稿更不全）。 */
function nonEmptyText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 装配成品预览的渲染数据。
 *
 * 返回 `null` 只表示「连类型都没有」；表单必填缺失（客户/上游）由调用方禁用入口，
 * 不在这里静默造假数据。
 */
export function buildCreatePreviewData(
  input: CreatePreviewInput,
): CreatePreview | null {
  const docType = nonEmptyText(input.docType);
  if (!docType) return null;

  const base = SAMPLE.base ?? {};
  const data: Record<string, unknown> = {
    ...base,
    ...(docType === "other" ? (SAMPLE.other_extra ?? {}) : {}),
  };
  const fromForm: string[] = [];

  // ① 币种：表单里始终有值（默认 USD），且提交时会原样送给后端
  const currency = nonEmptyText(input.currency)?.toUpperCase();
  if (currency) {
    data.currency = currency;
    fromForm.push("币种");
  }

  // ② 买方公司名：业务客户是开单必选项，也是单据上唯一的买方身份来源
  const customerName = nonEmptyText(input.customerName);
  if (customerName) {
    const buyer = base.buyer;
    data.buyer = {
      ...(typeof buyer === "object" && buyer !== null ? buyer : {}),
      company: customerName,
    };
    fromForm.push("业务客户");
  }

  // ③ 贸易条款：选了上游才覆盖（订单字段最全；报价单通常只有 incoterm）
  const upstream = input.upstream ?? null;
  if (upstream) {
    for (const field of TRADE_TERM_FIELDS) {
      const value = nonEmptyText(upstream[field]);
      if (!value) continue;
      data[field] = value;
      fromForm.push(TRADE_TERM_LABELS[field]);
    }
  }

  return { docType, data, fromForm };
}
