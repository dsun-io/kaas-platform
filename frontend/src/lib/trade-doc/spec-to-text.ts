/**
 * 结构化规格 → 单证用英文描述（规则化转换，确定性、可单测）。
 *
 * 为什么需要它：报价引擎产出的是**结构化中文工程参数**（`de` / `height_m` /
 * `mesh_mm` …），而单证（PI / CI / PL / 报关）需要的是**一行英文规格描述**。
 * 这不是字段搬运，是语义转换（见 `docs/TRADE_DOC_WORKSTATION_PLAN.md §1.5`）。
 *
 * 设计纪律（务必遵守，否则就是"产品知识泄漏到界面"）：
 *  1. **不在这里写死任何产品属性名**。属性的英文名一律取产品定义里的
 *     `label_en`（轴/变体、候选项都有），改产品定义 → 描述跟着变，前端不发版。
 *  2. 规则化能覆盖的范围内**不调 AI**。AI 只是"规则未覆盖的产品"的兜底，
 *     且其产出必须经人工确认（同一文档 §1.5）。
 *  3. 取不到名字的项**留空跳过**，不猜、不编、不填默认值 ——
 *     单证上印一个编造的规格，比留空危险得多。
 */
import type { ProductFormulasResponse } from "@contracts/export-quote";

/** 规格行：键是规格组名（如 height_m），值是候选取值。 */
export type SpecValues = Record<string, unknown>;

export interface SpecTextInput {
  formulas: ProductFormulasResponse;
  spec: SpecValues;
  /**
   * 按件改写的参数（**引擎单位**的值），如 `{ roll_len_m: 50, roll_dia_m: 0.3 }`。
   * 它必须参与描述：每卷多少米正是单证 `Specification` 列要体现的信息。
   */
  pieceBase?: Record<string, number | null | undefined>;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

/** 变体/轴的候选项或分组：`label_en` 缺失时退回中文 label，最后才退回取值本身。 */
function en(item: { label?: string; label_en?: string }, value?: unknown): string {
  return item.label_en || item.label || (value === undefined ? "" : textOf(value));
}

/**
 * 生成一行英文规格描述，如：
 *   `Net Height (m): 1.5 m, Vertical Wire Spacing (mm): 150 mm, Edge Wire Dia. (mm): 2.0,
 *    Length per Roll 50 m, Roll Diameter 0.3 m`
 *
 * 描述由「分组英文名: 候选项英文名」逐段拼接，段间用 `, ` 分隔；
 * 按件参数（每卷米数、卷径）追加在末尾 —— 它们是单证上最需要说明的包装信息。
 * 无任何可用信息时返回空串（调用方据此标黄提示，而不是印一行空白）。
 */
export function buildSpecification({
  formulas,
  spec,
  pieceBase,
}: SpecTextInput): string {
  const groups = [...(formulas.space?.axes ?? []), ...(formulas.space?.variants ?? [])];

  const parts: string[] = [];
  for (const group of groups) {
    const selected = spec[group.name];
    if (selected === undefined || selected === null || selected === "") continue;
    const option = group.options.find(
      (o) => textOf(o.value) === textOf(selected),
    );
    if (!option) continue;
    const groupName = en(group);
    const optionName = en(option, option.value);
    if (!groupName || !optionName) continue;
    parts.push(`${groupName}: ${optionName}`);
  }

  for (const pi of formulas.piece_inputs ?? []) {
    const raw = pieceBase?.[pi.key];
    if (raw === undefined || raw === null || !Number.isFinite(raw)) continue;
    const name = pi.label_en || pi.label;
    const unit = pi.unit || "";
    if (!name) continue;
    parts.push(`${name} ${raw}${unit ? ` ${unit}` : ""}`);
  }

  return parts.join(", ");
}

/**
 * 规格描述是否可用于单证。
 *
 * 判据故意宽松（非空即算可用）但**必须由调用方在界面上标黄提示缺项** ——
 * 单证的 Specification 列空白会被海关/银行退回，不能静默通过。
 */
export function isSpecificationUsable(text: string): boolean {
  return text.trim().length > 0;
}
