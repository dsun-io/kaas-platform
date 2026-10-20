/**
 * 合同 12 条中英双语条款 —— **默认措辞可编辑，正式签署前请法务/业务确认**。
 *
 * 用途（A6-2 预研的数据层）：合同 payload 的 `custom.clauses` 由此处默认值兜底，
 * 后续模板（`assets.json`/`render.ts`/`manifest.json`）由 A6-1/A6-2 集成本模块即可，
 * 本文件本身**不依赖**任何渲染器、无副作用、纯数据 + 纯函数。
 *
 * 措辞蓝本：`.tmp/a6-samples/contract.txt`（真实销售合同抽取，**未入库、不要提交**）。
 * 为什么默认文本里没有具体金额/汇率/单号/地址/公司名：
 *   ① 真实样例是客户商业数据，不能因为「抄模板」就把成交信息写进仓库；
 *   ② 默认模板若自带金额，容易被误当成「已填好」而签发 —— 成交信息应由合同 payload
 *      或 `custom.clauses` 注入（本模块只提供可复用措辞）。
 *
 * 覆盖语义（`resolveContractClauses`）：`custom.clauses` 按 `key` 覆盖内置条款，
 * 未知 `key` 追加到末尾；只覆盖显式给出的字符串字段（`text_*` 传空串 = 隐藏该语种），
 * 非数组/非法条目/空 key 一律忽略并回退内置 —— 纯函数，不抛、不修改入参。
 */

export interface ContractClause {
  /** 稳定标识；`custom.clauses` 按它覆盖内置条款。 */
  key: string;
  /** 条款标题（中文）。 */
  label_zh: string;
  /** 条款标题（英文）。 */
  label_en: string;
  /** 条款正文（中文）；空串 = 该语种隐藏。 */
  text_zh: string;
  /** 条款正文（英文）；空串 = 该语种隐藏。 */
  text_en: string;
}

/** `custom.clauses` 的单项：按 key 覆盖内置（未知 key 追加）。 */
export interface ContractClauseOverride {
  key: string;
  label_zh?: string;
  label_en?: string;
  text_zh?: string;
  text_en?: string;
}

/** 合同 custom 里与本模块相关的形状（其余字段由调用方自行保留）。 */
export interface ContractClausesCustom {
  clauses?: unknown;
}

const STRING_FIELDS = ["label_zh", "label_en", "text_zh", "text_en"] as const;
type StringField = (typeof STRING_FIELDS)[number];

/** 12 条默认条款（顺序 = 合同条款顺序；文案蓝本见文件头）。 */
export const DEFAULT_CONTRACT_CLAUSES: ContractClause[] = [
  {
    key: "quality",
    label_zh: "品质",
    label_en: "Quality",
    text_zh:
      "货物应符合上表所列名称与规格，并按要求进行热浸镀锌处理。原产国：中国。",
    text_en:
      "The goods shall conform to the description and specification set out above and shall be hot-dip galvanized as specified therein. Country of origin: P. R. China.",
  },
  {
    key: "packing",
    label_zh: "包装",
    label_en: "Packing",
    text_zh:
      "Y 型立柱：每托 400 根；可选每 10 根加装编织袋，费用见本合同约定。牛栏网：裸装供货；可选自吸膜缠绕包装，费用见本合同约定（按卷高区分费率）。电围栏支撑绝缘子：原厂包装；无原厂包装时装袋发货。可选包装另行计费。货物无商标，可按需贴牌。唛头：N/M（除双方另有约定）。",
    text_en:
      "Y-Type Fence Posts: 400 pcs per pallet; optional one woven bag per 10 posts, at the rate agreed in this Contract. Field Fence: supplied unwrapped; optional self-adhesive film wrapping at the rate agreed in this Contract (rate depends on roll height). Electric Fence Support Insulators: in the manufacturer's original packing, or in bags where the original packing is unavailable. Optional packing is charged extra. Goods are supplied unbranded; OEM marking on request. Shipping marks: N/M unless otherwise agreed.",
  },
  {
    key: "payment",
    label_zh: "付款",
    label_en: "Payment",
    text_zh:
      "电汇（T/T）支付至上述收款人账户：订单确认后支付 30% 定金，发货至约定交货地（交货前）付清 70% 尾款。定金/尾款金额见上表「付款与收款账户」栏；请以美元汇款。",
    text_en:
      "T/T in USD to the beneficiary account stated above: 30% deposit upon order confirmation; 70% balance to be paid in full upon dispatch of the goods to the agreed delivery place (before delivery). The deposit and balance amounts are those stated in the payment & bank details block above. Please remit in USD.",
  },
  {
    key: "delivery",
    label_zh: "交货",
    label_en: "Delivery",
    text_zh:
      "交货条件：DAP 约定目的地（Incoterms 2020），送货至买方指定地址；卖方责任至该指定地址交货为止，此后货物的拼柜与出运由买方自行安排（包括买方指定的其他供货商）。发运后运输约 4–5 天；具体交货期见上表（Y 型立柱约 10 天、牛栏网约 40 天，自订单确认起算）。总重与总体积见上表；至交货地址的内陆运费（如有）见上表金额块，并已含在应付总额内。生产期间卖方将按生产环节向买方提供货物照片。",
    text_en:
      "Delivery term: DAP at the agreed destination (Incoterms 2020), to the address designated by the Buyer. The Seller's responsibility ends upon delivery to that address; consolidation and export from there are arranged by the Buyer (including any other supplier designated by the Buyer). Transit takes approximately 4–5 days after dispatch; delivery lead times are those stated above (approx. 10 days for Y-type posts and 40 days for field fence, counted from order confirmation). Total weight and volume are as shown above; inland freight to the delivery address, if any, is stated in the amount block above and is included in the total amount payable. The Seller will keep the Buyer informed by providing photographs of the goods at each stage of production.",
  },
  {
    key: "documents",
    label_zh: "单据",
    label_en: "Documents",
    text_zh:
      "卖方提供：适用自贸协定项下的原产地证（如适用，例如中澳自贸协定 ChAFTA COO），便于买方享受关税优惠；无法出具时提供普通 CO。原产地证费用由卖方承担，不计入总价。买方应协助卖方提供相关出口报关单证——报关单、装箱单、运输单据副本及其他所需的单证——用于卖方出口退税及办理原产地证。",
    text_en:
      "Documents provided by the Seller: a Certificate of Origin under the applicable free trade agreement (where applicable, e.g. the China–Australia FTA / ChAFTA COO) enabling the Buyer to claim preferential tariff treatment; if such a certificate cannot be issued, a standard CO shall be provided instead. Charges for the Certificate of Origin are borne by the Seller and are NOT included in the total. The Buyer shall assist the Seller in providing the relevant export customs declaration documents — customs declaration form, packing list, copies of the transport documents and such other documents as may be required — for the Seller's export tax rebate and for the issuance of the Certificate of Origin.",
  },
  {
    key: "tax",
    label_zh: "税费",
    label_en: "Tax",
    text_zh: "出口贸易（一般贸易）。出口销售适用零税率（0% VAT），出口退税由卖方办理。",
    text_en:
      "Export trade (general trade). Export sales are zero-rated (0% VAT); the Seller handles the export tax rebate.",
  },
  {
    key: "price_basis",
    label_zh: "价格基础",
    label_en: "Price Basis",
    text_zh:
      "单价按 2 位小数四舍五入列示；合计按未舍入单价计算（见上表「舍入调整」行）。美元金额按本合同约定汇率折算（中国银行美元现汇买入价；汇率与日期见上表）。",
    text_en:
      "Unit prices are rounded to 2 decimal places; totals are calculated from unrounded unit prices (see the rounding adjustment in the amount block above). USD amounts are converted at the exchange rate stated in this Contract (Bank of China USD spot buying rate; rate and date as shown above).",
  },
  {
    key: "inspection_claims",
    label_zh: "检验与索赔",
    label_en: "Inspection & Claims",
    text_zh:
      "买方应于货到后检验；如有索赔，应于到货后 30 天内书面通知卖方，并附认可检验机构出具的检验报告。因不当储存、搬运或使用引起的索赔，卖方不承担责任。",
    text_en:
      "The Buyer shall inspect the goods upon arrival and shall notify the Seller in writing of any claim within 30 days of arrival, supported by an inspection report issued by a recognised surveyor. The Seller shall not be liable for claims arising from improper storage, handling or use.",
  },
  {
    key: "force_majeure",
    label_zh: "不可抗力",
    label_en: "Force Majeure",
    text_zh:
      "因不可抗力（包括但不限于自然灾害、战争、政府行为、疫情、港口拥堵、罢工）导致不能或延迟履行的，双方互不承担责任。受影响方应及时通知对方并提供证明。",
    text_en:
      "Neither party shall be liable for failure or delay in performance caused by events beyond its reasonable control, including but not limited to natural disasters, war, government action, epidemics, port congestion or strikes. The affected party shall notify the other party promptly and furnish evidence.",
  },
  {
    key: "arbitration",
    label_zh: "仲裁",
    label_en: "Arbitration",
    text_zh:
      "因本合同引起的或与本合同有关的任何争议，应首先友好协商解决；协商不成的，提交中国国际经济贸易仲裁委员会（CIETAC）按其现行仲裁规则仲裁。仲裁裁决为终局裁决，对双方均有约束力。",
    text_en:
      "Any dispute arising out of or in connection with this Contract shall first be settled amicably; failing which it shall be submitted to the China International Economic and Trade Arbitration Commission (CIETAC) for arbitration in accordance with its rules then in force. The award shall be final and binding upon both parties.",
  },
  {
    key: "governing_law",
    label_zh: "适用法律",
    label_en: "Governing Law",
    text_zh:
      "本合同适用中华人民共和国法律。本合同依据上表所列形式发票签订，该形式发票条款构成本合同组成部分；两者如有不一致，以该形式发票为准。本合同以中英文书就，两种文本具有同等法律效力；如中英文不一致，以中文文本为准。任何修改须经双方书面签署。一式两份，双方各执一份。",
    text_en:
      "This Contract shall be governed by the laws of the People's Republic of China. This Contract is made pursuant to the Proforma Invoice referenced above, the terms of which form part of this Contract; in the event of any inconsistency between the two, the Proforma Invoice shall prevail. This Contract is made in English and Chinese, both texts being equally authentic. In case of any discrepancy, the Chinese version shall prevail. Any amendment shall be made in writing signed by both parties. Two originals, one for each party.",
  },
  {
    key: "effectiveness_annexes",
    label_zh: "生效与附件",
    label_en: "Effectiveness & Annexes",
    text_zh:
      "本合同自双方签字盖章之日起生效。双方同意本合同可通过电子方式签署并交换——以电子邮件交换扫描件，或经电子签名平台签署——该等签署副本与原件具有同等法律效力。构成本合同组成部分的附件：上表所列形式发票与商业发票。",
    text_en:
      "This Contract shall come into effect upon being signed and stamped by both parties. The parties agree that it may be signed and exchanged by electronic means — scanned copies exchanged by e-mail, or signature through an electronic signature platform — and that such signed copies shall have the same legal effect as the originals. Annexes forming an integral part of this Contract: the Proforma Invoice and Commercial Invoice referenced above.",
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cloneClause(clause: ContractClause): ContractClause {
  return {
    key: clause.key,
    label_zh: clause.label_zh,
    label_en: clause.label_en,
    text_zh: clause.text_zh,
    text_en: clause.text_en,
  };
}

/**
 * 解析合同条款：内置 12 条 + `custom.clauses` 覆盖/追加。
 *
 * - `custom` 为空/非对象/`clauses` 非数组 ⇒ 返回内置条款的**副本**（不返回原数组，调用方可安全修改）；
 * - 已知 `key`：只用条目里**显式给出的字符串字段**覆盖（`""` 是合法覆盖 = 隐藏该语种）；
 * - 未知 `key`（trim 后非空）：追加到末尾；缺 label 时用 key 兜底，缺正文用空串；
 * - 重复 `key` 按出现顺序合并（后者覆盖前者），结果 key 恒唯一；
 * - 纯函数：不抛、不修改 `DEFAULT_CONTRACT_CLAUSES` 与入参。
 */
export function resolveContractClauses(custom?: unknown): ContractClause[] {
  const resolved = DEFAULT_CONTRACT_CLAUSES.map(cloneClause);
  const indexByKey = new Map<string, number>(
    resolved.map((clause, index) => [clause.key, index]),
  );

  if (!isRecord(custom) || !Array.isArray(custom.clauses)) {
    return resolved;
  }

  for (const raw of custom.clauses as unknown[]) {
    if (!isRecord(raw)) continue;
    const rawKey = raw["key"];
    const key = typeof rawKey === "string" ? rawKey.trim() : "";
    if (!key) continue;

    const patch: Partial<Record<StringField, string>> = {};
    for (const field of STRING_FIELDS) {
      const value = raw[field];
      if (typeof value === "string") patch[field] = value;
    }

    const existingIndex = indexByKey.get(key);
    if (existingIndex !== undefined) {
      const current = resolved[existingIndex];
      if (!current) continue;
      resolved[existingIndex] = {
        key,
        label_zh: patch.label_zh ?? current.label_zh,
        label_en: patch.label_en ?? current.label_en,
        text_zh: patch.text_zh ?? current.text_zh,
        text_en: patch.text_en ?? current.text_en,
      };
      continue;
    }

    const appended: ContractClause = {
      key,
      label_zh: patch.label_zh ?? key,
      label_en: patch.label_en ?? key,
      text_zh: patch.text_zh ?? "",
      text_en: patch.text_en ?? "",
    };
    indexByKey.set(key, resolved.length);
    resolved.push(appended);
  }

  return resolved;
}
