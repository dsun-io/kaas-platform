/**
 * 产品规格编辑器 · 类型 / 常量 / 纯函数（U-P1D2 从 product-spec-editor 拆出）。
 *
 * 与 backend services/export_quote/models.py 的 ProductSpec 子形状对齐；
 * `parseSpec/stringifySpec` 是"JSON 文本 ↔ spec 对象"的唯一转换点（P14：JSON 是唯一真源）。
 */
// ── ProductSpec 的子形状（与 backend services/export_quote/models.py 对齐）──
export interface NumericInputItem {
  key: string;
  label: string;
  label_en?: string;
  unit?: string;
  default?: number;
  min_value?: number | null;
  max_value?: number | null;
  decimals?: number | null;
  note?: string;
}

export interface VariantOption {
  name: string;
  [k: string]: unknown;
}

export interface VariantGroupItem {
  name: string;
  label?: string;
  label_en?: string;
  options: VariantOption[];
}

export interface DerivedItem {
  name: string;
  expr: string;
  decimals?: number | null;
  integer?: boolean;
  label?: string;
  label_en?: string;
  unit?: string;
  note?: string;
}

// ── S6.2：报表列 / 校验规则 / 空间扣减 ──────────────────────────────────────
export interface ColumnItem {
  key: string;
  label?: string;
  label_en?: string;
  decimals?: number | null;
  /** internal=True 的列只进内部核算视图（对外展示不得暴露成本利润率的落地点） */
  internal?: boolean;
  width?: number | null;
}

export interface InvariantItem {
  name: string;
  expr: string;
  severity?: "error" | "warning";
}

export interface SpaceDeductionItem {
  mode?: string;
  value?: number | string | null;
  range?: [number, number] | null;
  expr?: string;
  note?: string;
}

// ── S6.3：params / notes / constants ───────────────────────────────────────
/** params 是 4 元组列表：[参数, 取值, 单位, 说明]（与 ProductSpec.params 一致） */
export type ParamRow = [string, string, string, string];

export type SpecShape = {
  key?: string;
  name?: string;
  numeric_inputs?: NumericInputItem[];
  variants?: VariantGroupItem[];
  derived?: DerivedItem[];
  columns?: ColumnItem[];
  invariants?: InvariantItem[];
  space_deduction?: SpaceDeductionItem;
  params?: ParamRow[];
  notes?: string[];
  constants?: Record<string, number | string>;
  [k: string]: unknown;
};

export type EditorTab = "specs" | "derived" | "report" | "meta" | "json";

export interface ProductSpecEditorProps {
  /** P14 保留的真源 JSON 文本（stringify 出来的；parse 失败时显示错误并禁用表单） */
  specJson: string;
  onChange: (next: string) => void;
  /** 产品 key（新建时为空，保存时由上层同步进 spec.key） */
  productKey?: string;
}

export const EMPTY_NUMERIC: NumericInputItem = {
  key: "",
  label: "",
  label_en: "",
  unit: "",
  default: 0,
  min_value: null,
  max_value: null,
  decimals: 2,
  note: "",
};

export const EMPTY_VARIANT: VariantGroupItem = {
  name: "",
  label: "",
  label_en: "",
  options: [{ name: "" }],
};

export const EMPTY_DERIVED: DerivedItem = {
  name: "",
  expr: "",
  decimals: 4,
  integer: false,
  label: "",
  label_en: "",
  unit: "",
  note: "",
};

export const EMPTY_COLUMN: ColumnItem = {
  key: "",
  label: "",
  label_en: "",
  decimals: 4,
  internal: false,
  width: null,
};

export const EMPTY_INVARIANT: InvariantItem = {
  name: "",
  expr: "",
  severity: "error",
};

/** 空间扣减默认口径：按比例（ratio），推荐——固定值在小单上会扣出负体积。 */
export const EMPTY_SPACE_DEDUCTION: SpaceDeductionItem = {
  mode: "ratio",
  value: 0,
  note: "",
};

/** JSON 文本 → spec 对象（失败返回 null，调用方走错误态） */
export function parseSpec(json: string): SpecShape | null {
  try {
    return JSON.parse(json || "{}") as SpecShape;
  } catch {
    return null;
  }
}

/** 生成新的 JSON 文本（保持 key/name 与 P16 之后未知字段原样透传） */
export function stringifySpec(spec: SpecShape): string {
  return JSON.stringify(spec, null, 2);
}
