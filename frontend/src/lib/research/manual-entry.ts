/**
 * 调研产品「手工录入」（C36 #22）—— 纯函数层：表单校验、POST 组装、409 解释。
 *
 * 后端契约（`backend/worker/src/chain.py:2137-2294`）：
 * - `POST /api/v1/research/products`，所有字段可选；`source_ref` 指向线索时后端自动回填产品/店铺字段；
 * - 同一线索重复挑选 → 409 `ALREADY_PICKED`（detail 带 `research_id`）；
 * - 线索不存在 → 404 `LEAD_NOT_FOUND`；未开通调研工位 → 403（`_require_sub`）。
 *
 * 前端口径：**产品名或线索至少一个**（否则建出一条空记录）；价格填了就必须是数字。
 */
import { normalizeApiError } from "@/lib/api/api-error";

export interface ManualResearchForm {
  /** 从线索挑选（`lead_candidates.id`）；空串 = 手工录入 */
  sourceRef: string;
  productName: string;
  productNameCn: string;
  productCategory: string;
  country: string;
  region: string;
  city: string;
  shopName: string;
  priceLocal: string;
  priceCurrency: string;
  /** "true" / "false" / ""（未填） */
  canSupply: string;
  marketNote: string;
}

export const EMPTY_MANUAL_RESEARCH_FORM: ManualResearchForm = {
  sourceRef: "",
  productName: "",
  productNameCn: "",
  productCategory: "",
  country: "",
  region: "",
  city: "",
  shopName: "",
  priceLocal: "",
  priceCurrency: "",
  canSupply: "",
  marketNote: "",
};

/** 返回人类可读错误（空数组 = 通过）。 */
export function validateManualResearchForm(form: ManualResearchForm): string[] {
  const errors: string[] = [];
  if (!form.sourceRef.trim() && !form.productName.trim()) {
    errors.push("产品名或「从线索挑选」至少填一个");
  }
  if (form.priceLocal.trim()) {
    const n = Number(form.priceLocal);
    if (!Number.isFinite(n) || n < 0) errors.push("本地价格必须是非负数字");
  }
  return errors;
}

/**
 * 表单 → POST body：空串不送（后端 `exclude_none` 后只写有值的列），
 * `source_ref` 转数字，价格转数字，`can_supply` 三态转 boolean/省略。
 */
export function buildManualResearchPayload(
  form: ManualResearchForm,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const text = (v: string) => {
    const s = v.trim();
    return s === "" ? undefined : s;
  };
  const sourceRef = form.sourceRef.trim() ? Number(form.sourceRef) : undefined;
  if (sourceRef !== undefined) body.source_ref = sourceRef;
  const mappings: [keyof ManualResearchForm, string][] = [
    ["productName", "product_name"],
    ["productNameCn", "product_name_cn"],
    ["productCategory", "product_category"],
    ["country", "country"],
    ["region", "region"],
    ["city", "city"],
    ["shopName", "shop_name"],
    ["priceCurrency", "price_currency"],
    ["marketNote", "market_note"],
  ];
  for (const [key, apiKey] of mappings) {
    const value = text(String(form[key]));
    if (value !== undefined) body[apiKey] = value;
  }
  if (form.priceLocal.trim()) body.price_local = Number(form.priceLocal);
  if (form.canSupply === "true") body.can_supply = true;
  else if (form.canSupply === "false") body.can_supply = false;
  return body;
}

/**
 * 409 `ALREADY_PICKED` 的专属文案（其他错误返回 null，交给通用错误展示）。
 * 后端 detail 形如 `{error:"conflict", code:"ALREADY_PICKED", research_id: 12}`。
 */
export function explainResearchConflict(error: unknown): string | null {
  const info = normalizeApiError(error);
  if (info.status !== 409) return null;
  const response = (error as { response?: { data?: unknown } } | null)?.response;
  const data = response?.data as
    | { detail?: { code?: string; research_id?: number } }
    | undefined;
  const detail = data?.detail;
  if (detail?.code === "ALREADY_PICKED" || info.code === "ALREADY_PICKED") {
    return detail?.research_id
      ? `该线索已在调研集中（调研产品 #${detail.research_id}），不能重复挑选`
      : "该线索已在调研集中，不能重复挑选";
  }
  return info.message && info.message !== "请求失败，请稍后重试"
    ? info.message
    : "请求冲突（409），请刷新后重试";
}
