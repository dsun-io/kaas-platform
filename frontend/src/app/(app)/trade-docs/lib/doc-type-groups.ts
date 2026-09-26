/**
 * 单证类型分组（开单表单与样板预览共用）。
 *
 * 为什么要分组：18 类单据的业务性质差别很大 ——
 * 「出口商自制」是我方出具、可直接发客户；「第三方签发」本系统只出申报/申请信息，
 * 真正的凭证由货代/商检/贸促会出具。不区分清楚，用户容易误以为打印出来就能当正式凭证用。
 */
export const THIRD_PARTY_TYPES = new Set([
  "bl",
  "co",
  "insurance",
  "customs_declaration",
  "fumigation_cert",
]);

export const DOC_TYPE_GROUPS: { label: string; types: string[] }[] = [
  {
    label: "出口商自制（我方出具，可直接发客户）",
    types: [
      "quotation",
      "pi",
      "contract",
      "ci",
      "pl",
      "shipping_advice",
      "draft",
      "beneficiary_cert",
      "non_wood_packing",
      "weight_list",
      "quality_cert",
      "manufacturer_cert",
    ],
  },
  {
    label: "第三方签发（本系统出申报/申请信息，凭证由对方出具）",
    types: ["bl", "co", "insurance", "customs_declaration", "fumigation_cert"],
  },
  { label: "通用", types: ["other"] },
];
