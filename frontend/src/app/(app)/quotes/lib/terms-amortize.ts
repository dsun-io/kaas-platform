/**
 * 贸易术语费用项的**整单分摊**（多产品报价专用）。
 *
 * 为什么需要它：出口费用项有六种计价方式（见后端 `terms.py::amount_per_piece`）：
 *
 * | mode | 引擎对**单件**的算法 | 多产品逐行下发时的行为 |
 * |---|---|---|
 * | `per_weight_kg` / `per_weight_ton` | 单价 × 本行重量 | 线性 → 逐行累加 == 整单一次 ✔ |
 * | `per_piece` | 就是"每卷多少元" | 线性 ✔ |
 * | `ratio_of_subtotal` / `insurance_of_cif` | 按本行金额比例 | 线性 ✔ |
 * | `per_shipment` | `value ÷ 本行件数` | **整批金额会被每行各计一次 → 总数放大 N 倍 ✘** |
 *
 * 所以只有 `per_shipment` 需要处理，而且**必须按件数比例分摊、不能平均分**：
 * 引擎拿到某行的整批金额后会除以**该行的件数**摊到单卷，于是
 *   · 平均分（V/N）：件数少的行单卷分摊偏高，Per-roll 运价在各行不一致；
 *   · 按件数比例（V × 本行件数 / 总件数）：摊到单卷后**每一行的每卷分摊完全相同**
 *     （= V ÷ 总件数），且逐行累加正好回到 V —— 后者才是"整批费用落在每卷上"的口径。
 *
 * 界面必须显式说明"整批费用已按件数分摊"，否则用户会以为自己填的是每行的费用。
 */
import type { ExportTermsFee, ExportTermsTemplate } from "@contracts/export-quote";

/** 整批一次计取的计价模式（逐行下发前需要按件数分摊）。 */
export const PER_SHIPMENT_MODE = "per_shipment";

export interface BuiltTerms {
  base: string;
  quote_as: string;
  weight_field: string;
  items: Record<string, unknown>;
  ladder: ExportTermsTemplate["ladder"];
}

/** 该费用项是否属于"整批一次"（需要分摊）。 */
export function isPerShipment(fee: Pick<ExportTermsFee, "mode">): boolean {
  return fee.mode === PER_SHIPMENT_MODE;
}

/**
 * 把用户填的**整批**金额摊到每一行。
 *
 * @param amounts 用户在界面上填的整批金额（元）
 * @param shares  每行的分摊权重（用**件数**）：
 *                空数组 / 全为 0 → 退化为平均分摊（等于"行数与件数都不可知"）
 * @returns 每行一份 `terms`（可直接下发）+ 被分摊的费用项键名（界面提示用）
 */
export function buildTermsPerLine(
  template: ExportTermsTemplate,
  amounts: Record<string, number>,
  shares: number[],
  quoteAs?: string,
): { terms: BuiltTerms[]; amortized: string[] } {
  // 2026-10-18：显式给了条款时，阶梯截断到所选条款 —— 只算用户要报的那一档，
  // 避免"没填海运费却算出 CIF 价"这种误导；quote_as 必须等于所选条款。
  // 未显式给（旧调用/测试）时保持旧行为：模板原样、quote_as 用模板默认值。
  const explicit = (quoteAs ?? "").trim().toUpperCase();
  const idx = explicit
    ? template.ladder.findIndex((r) => r.code === explicit)
    : -1;
  const ladder = idx >= 0 ? template.ladder.slice(0, idx + 1) : template.ladder;
  const code = idx >= 0 ? explicit : template.quote_as;
  const visible = new Set(ladder.flatMap((r) => r.items ?? []));

  const n = Math.max(1, Math.floor(shares.length || 1));
  const cleaned = Array.from({ length: n }, (_, i) => {
    const v = Number(shares[i]);
    return Number.isFinite(v) && v > 0 ? v : 0;
  });
  const total = cleaned.reduce((a, b) => a + b, 0);
  // 总件数为 0（各行都还没填件数）→ 平均分摊，保证金额不被吞掉
  const weights = total > 0 ? cleaned : cleaned.map(() => 1);
  const weightSum = weights.reduce((a, b) => a + b, 0);

  const amortized: string[] = [];
  const terms: BuiltTerms[] = [];

  for (let i = 0; i < n; i += 1) {
    const items: Record<string, unknown> = {};
    for (const [key, fee] of Object.entries(template.items ?? {})) {
      if (!visible.has(key)) continue; // 高于所选条款的费用项不下发
      const amount = Number(amounts[key]) || 0;
      if (isPerShipment(fee)) {
        if (n > 1 && !amortized.includes(key)) amortized.push(key);
        const share = weights[i] ?? 0;
        items[key] = { ...fee, value: (amount * share) / weightSum };
      } else {
        // 线性口径的费用（按重量 / 按卷 / 按比例）本来就是整单口径，逐行累加即等价
        items[key] = { ...fee, value: amount };
      }
    }
    terms.push({
      base: template.base,
      quote_as: code,
      weight_field: template.weight_field,
      items,
      ladder,
    });
  }

  return { terms, amortized };
}

/** 所选条款下需要填写的费用项（从 EXW 到该档累计、去重保序）。 */
export function requiredFeeKeysFor(
  template: ExportTermsTemplate,
  quoteAs: string,
): string[] {
  const wanted = (quoteAs || "EXW").toUpperCase();
  const idx = template.ladder.findIndex((r) => r.code === wanted);
  const ladder = idx >= 0 ? template.ladder.slice(0, idx + 1) : template.ladder;
  const keys: string[] = [];
  for (const rung of ladder) {
    for (const key of rung.items ?? []) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}
