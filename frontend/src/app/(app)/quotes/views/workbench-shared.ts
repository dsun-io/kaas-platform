"use client";

/**
 * 报价工作台 · 共享常量 / 小工具 / 展示类型。
 *
 * 从 `quote-workbench-view.tsx` 抽出（纯搬家，行为不变）：
 * 这些值被「状态层 / 动作层 / 汇总卡 / 参数卡」多处共用，集中一处避免漂移。
 */

/** 上次用过的汇率，避免每次报价重复输入（仅作预填，仍需业务确认）。 */
export const FX_KEY = "kaas:last-fx-rate";

/** 报价政策的默认值 —— 与后端默认政策等价，因此本身不改变任何金额。 */
export const POLICY_DEFAULTS = {
  inputVatRatePct: "10",
  giveRatioPct: "80",
  outputVatRatePct: "0",
  rebateRatePct: "",
  miscTaxPct: "3",
};

/** 默认生成哪几种单证：按业务顺序的前两张（报价单 + 形式发票）。 */
export const DEFAULT_DOC_PICK = ["quotation", "pi"];

/** 本地今天（YYYY-MM-DD）—— 报价日期默认值。 */
export function todayISO(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * 报价有效期截止日（YYYY-MM-DD；非法日期 → null）。
 * 默认 7 天：`validityDays` 为空/非数字时的兜底与改版前一致。
 */
export function validUntil(
  quoteDate: string,
  validityDays: string,
): string | null {
  const days = Number(validityDays) || 7;
  const base = quoteDate ? new Date(`${quoteDate}T00:00:00Z`) : new Date();
  if (Number.isNaN(base.getTime())) return null;
  const end = new Date(base.getTime() + days * 24 * 3600 * 1000);
  return end.toISOString().slice(0, 10);
}

/** 百分比字符串（"10"）→ 小数比率（0.1）；空串 → undefined（与后端"未填"同义）。 */
export function pctToRate(text: string): number | undefined {
  return text === "" ? undefined : (Number(text) || 0) / 100;
}

/** 小数比率（0.1）→ 百分比字符串（"10"）；undefined 回退默认文案。 */
export function rateToPct(rate: number | undefined, fallback: string): string {
  return rate === undefined
    ? fallback
    : String(Math.round(rate * 100 * 1e6) / 1e6);
}

/** 已落库的报价单头部快照（右侧汇总卡与底部吸底条共用）。 */
export interface SavedQuoteDoc {
  id: number;
  quote_no: string;
  status: string;
}

/** 页内提示（info=成功/说明；error=失败原因原文）。 */
export interface WorkbenchNotice {
  tone: "info" | "error";
  text: string;
}

/** 客户名下询盘（下拉自动带出询盘编号，而不是让人手填数字 ID）。 */
export interface InquiryOption {
  id: number;
  inquiry_no?: string | null;
  product_name_raw?: string | null;
  status?: string | null;
}

/** 产品税率映射（进项税/出口退税率按产品带出）。 */
export interface ProductTaxMap {
  [productKey: string]: {
    input_vat_rate?: number | null;
    rebate_rate?: number | null;
  };
}
