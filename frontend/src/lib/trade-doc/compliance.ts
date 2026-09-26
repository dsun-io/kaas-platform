/**
 * 单证合规检查 —— 出单前告诉业务员「还差什么」，而不是印出空白单据。
 *
 * 为什么需要：报关/信用证审单是按字段逐项核对的。少一个 HS Code、
 * 少一个收货人地址，到了海关或银行就是「不符点」，要退单重做。
 * 与其让人自己逐行检查，不如让系统在开单前就点出来。
 */
import { getTemplateFields, type TradeDocType } from "./render";

export interface MissingField {
  field: string;
  label: string;
  type: string;
}

/** 字段名 → 中文可读名（模板里的描述本身就是中文，取其首段即可） */
const FIELD_LABELS: Record<string, string> = {
  seller: "卖方信息",
  buyer: "买方信息",
  consignee: "收货人",
  notify_party: "通知方",
  items: "商品明细",
  total_amount: "总金额",
  currency: "币种",
  incoterm: "贸易术语",
  payment_terms: "付款方式",
  delivery_time: "交货期",
  port_of_loading: "装运港",
  port_of_destination: "目的港",
  country_of_origin: "原产国",
  description_of_goods: "货物描述",
  insured_amount: "保险金额",
  coverage: "投保险别",
  gross_weight: "毛重",
  volume: "体积",
  quantity: "数量",
  shipping_marks: "唛头",
  remarks: "备注",
};

function labelOf(field: string, spec: { description?: string }): string {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field];
  // 单证编号类字段：xxx_no → 「本单编号」，用模板描述兜底
  const desc = spec.description?.split(/[(（]/)[0]?.trim();
  return desc && desc.length <= 12 ? desc : field;
}

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object")
    return Object.keys(value as object).length === 0;
  return false;
}

/**
 * 返回必填但为空的字段清单。
 * 只检查模板标记为 required 的字段 —— 可选字段留空是正常业务（如信用证没有的就不填）。
 */
export function findMissingRequiredFields(
  docType: string,
  data: Record<string, unknown>,
): MissingField[] {
  const fields = getTemplateFields(docType) as Record<
    string,
    { type?: string; required?: boolean; description?: string }
  > | null;
  if (!fields) return [];

  const missing: MissingField[] = [];
  for (const [field, spec] of Object.entries(fields)) {
    if (!spec.required) continue;
    if (!isBlank(data[field])) continue;
    missing.push({
      field,
      label: labelOf(field, spec),
      type: spec.type ?? "string",
    });
  }
  return missing;
}

/** 是否可签发（必填齐全才算合规单据） */
export function isIssuable(
  docType: string,
  data: Record<string, unknown>,
): boolean {
  return findMissingRequiredFields(docType, data).length === 0;
}

export type { TradeDocType };
