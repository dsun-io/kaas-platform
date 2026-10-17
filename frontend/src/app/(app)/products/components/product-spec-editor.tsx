"use client";

/**
 * 产品规格可视化编辑器（P16 · 第一步 S6.1）。
 *
 * 三段式（与 PRODUCT_MODULE_MERGE_PLAN §5 对齐）：
 *   S6.1 本文件 = 数值参数（`numeric_inputs`）+ 变体档位（`variants`）
 *                 + 派生公式（`derived`）
 *   S6.2 后续 = 列（`columns`）+ 不变量（`invariants`）+ 空间扣减（`space_deduction`）
 *   S6.3 后续 = 参考参数（`params`）+ 说明（`notes`）+ 常量（`constants`）+ 公式试算
 *
 * **三条硬约束**（同一文档）：
 * 1. 不按 `Axis` 设计控件（三产品 `axes=[]`，画了也没人用）；
 * 2. 不新建接口 —— 保存仍走 `/tenant-products`，试算走 `/explain` 的 `spec_override`；
 * 3. **JSON 文本框原样保留为「高级 JSON」模式**（P14 硬约束①）：
 *    `specJson` 是唯一真源，表单编辑生成新 JSON 写回、JSON 手改反向喂表单
 *    —— 两条路径永远看到同一份数据，任何一侧都能兜住另一侧的失误。
 */
import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// ── ProductSpec 的子形状（与 backend services/export_quote/models.py 对齐）──
interface NumericInputItem {
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

interface VariantOption {
  name: string;
  [k: string]: unknown;
}

interface VariantGroupItem {
  name: string;
  label?: string;
  label_en?: string;
  options: VariantOption[];
}

interface DerivedItem {
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
interface ColumnItem {
  key: string;
  label?: string;
  label_en?: string;
  decimals?: number | null;
  /** internal=True 的列只进内部核算视图（对外展示不得暴露成本利润率的落地点） */
  internal?: boolean;
  width?: number | null;
}

interface InvariantItem {
  name: string;
  expr: string;
  severity?: "error" | "warning";
}

interface SpaceDeductionItem {
  mode?: string;
  value?: number | string | null;
  range?: [number, number] | null;
  expr?: string;
  note?: string;
}

// ── S6.3：params / notes / constants ───────────────────────────────────────
/** params 是 4 元组列表：[参数, 取值, 单位, 说明]（与 ProductSpec.params 一致） */
type ParamRow = [string, string, string, string];

type SpecShape = {
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

type EditorTab = "specs" | "derived" | "report" | "meta" | "json";

interface ProductSpecEditorProps {
  /** P14 保留的真源 JSON 文本（stringify 出来的；parse 失败时显示错误并禁用表单） */
  specJson: string;
  onChange: (next: string) => void;
  /** 产品 key（新建时为空，保存时由上层同步进 spec.key） */
  productKey?: string;
}

const EMPTY_NUMERIC: NumericInputItem = {
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

const EMPTY_VARIANT: VariantGroupItem = {
  name: "",
  label: "",
  label_en: "",
  options: [{ name: "" }],
};

const EMPTY_DERIVED: DerivedItem = {
  name: "",
  expr: "",
  decimals: 4,
  integer: false,
  label: "",
  label_en: "",
  unit: "",
  note: "",
};

const EMPTY_COLUMN: ColumnItem = {
  key: "",
  label: "",
  label_en: "",
  decimals: 4,
  internal: false,
  width: null,
};

const EMPTY_INVARIANT: InvariantItem = {
  name: "",
  expr: "",
  severity: "error",
};

/** 空间扣减默认口径：按比例（ratio），推荐——固定值在小单上会扣出负体积。 */
const EMPTY_SPACE_DEDUCTION: SpaceDeductionItem = {
  mode: "ratio",
  value: 0,
  note: "",
};

/** JSON 文本 → spec 对象（失败返回 null，调用方走错误态） */
function parseSpec(json: string): SpecShape | null {
  try {
    return JSON.parse(json || "{}") as SpecShape;
  } catch {
    return null;
  }
}

/** 生成新的 JSON 文本（保持 key/name 与 P16 之后未知字段原样透传） */
function stringifySpec(spec: SpecShape): string {
  return JSON.stringify(spec, null, 2);
}

/** 数值字段的通用输入（"留空 = null"，避免把 0 误当成用户填的值） */
function NumberField({
  label,
  value,
  step,
  onChange,
  className,
}: {
  label: string;
  value: number | null | undefined;
  step?: string;
  onChange: (v: number | null) => void;
  className?: string;
}) {
  return (
    <div className={className}>
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        type="number"
        step={step}
        value={value ?? ""}
        onChange={(e) => {
          const raw = e.target.value.trim();
          onChange(raw === "" ? null : Number(raw));
        }}
        className="h-7 text-xs"
      />
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  className,
  placeholder,
  mono,
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string) => void;
  className?: string;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <div className={className}>
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn("h-7 text-xs", mono && "font-mono")}
      />
    </div>
  );
}

export function ProductSpecEditor({
  specJson,
  onChange,
  productKey,
}: ProductSpecEditorProps) {
  const [tab, setTab] = useState<EditorTab>("specs");

  // 表单与 JSON 同步：specJson 是唯一真源（P14 约束）
  const spec = useMemo(() => parseSpec(specJson), [specJson]);
  const parseOk = spec !== null;

  // 表单改动 → 生成新 JSON 写回 specJson（不引入"未应用的草稿"——
  // 那会让人改完 JSON 忘点应用，保存时把改动静默丢掉）。
  const commit = (next: SpecShape) => {
    onChange(stringifySpec(next));
  };

  // ── 数值参数 ──────────────────────────────────────────────────────────────
  const numerics = spec?.numeric_inputs ?? [];
  const patchNumeric = (index: number, patch: Partial<NumericInputItem>) => {
    const next = numerics.map((n, i) => (i === index ? { ...n, ...patch } : n));
    commit({ ...(spec ?? {}), numeric_inputs: next });
  };
  const addNumeric = () =>
    commit({
      ...(spec ?? {}),
      numeric_inputs: [...numerics, { ...EMPTY_NUMERIC }],
    });
  const removeNumeric = (index: number) =>
    commit({
      ...(spec ?? {}),
      numeric_inputs: numerics.filter((_, i) => i !== index),
    });

  // ── 变体档位 ──────────────────────────────────────────────────────────────
  const variants = spec?.variants ?? [];
  const patchVariant = (index: number, patch: Partial<VariantGroupItem>) => {
    const next = variants.map((v, i) => (i === index ? { ...v, ...patch } : v));
    commit({ ...(spec ?? {}), variants: next });
  };
  const addVariant = () =>
    commit({
      ...(spec ?? {}),
      variants: [...variants, { ...EMPTY_VARIANT, options: [{ name: "" }] }],
    });
  const removeVariant = (index: number) =>
    commit({
      ...(spec ?? {}),
      variants: variants.filter((_, i) => i !== index),
    });

  // ── 派生公式 ──────────────────────────────────────────────────────────────
  const derived = spec?.derived ?? [];
  const patchDerived = (index: number, patch: Partial<DerivedItem>) => {
    const next = derived.map((d, i) => (i === index ? { ...d, ...patch } : d));
    commit({ ...(spec ?? {}), derived: next });
  };
  const addDerived = () =>
    commit({ ...(spec ?? {}), derived: [...derived, { ...EMPTY_DERIVED }] });
  const removeDerived = (index: number) =>
    commit({ ...(spec ?? {}), derived: derived.filter((_, i) => i !== index) });

  // ── S6.2：报表列 / 校验规则 / 空间扣减 ───────────────────────────────────
  const columns = spec?.columns ?? [];
  const patchColumn = (index: number, patch: Partial<ColumnItem>) => {
    const next = columns.map((c, i) => (i === index ? { ...c, ...patch } : c));
    commit({ ...(spec ?? {}), columns: next });
  };
  const addColumn = () =>
    commit({ ...(spec ?? {}), columns: [...columns, { ...EMPTY_COLUMN }] });
  const removeColumn = (index: number) =>
    commit({
      ...(spec ?? {}),
      columns: columns.filter((_, i) => i !== index),
    });

  const invariants = spec?.invariants ?? [];
  const patchInvariant = (index: number, patch: Partial<InvariantItem>) => {
    const next = invariants.map((v, i) =>
      i === index ? { ...v, ...patch } : v,
    );
    commit({ ...(spec ?? {}), invariants: next });
  };
  const addInvariant = () =>
    commit({
      ...(spec ?? {}),
      invariants: [...invariants, { ...EMPTY_INVARIANT }],
    });
  const removeInvariant = (index: number) =>
    commit({
      ...(spec ?? {}),
      invariants: invariants.filter((_, i) => i !== index),
    });

  const spaceDeduction = spec?.space_deduction;
  const patchSpaceDeduction = (patch: Partial<SpaceDeductionItem>) => {
    commit({
      ...(spec ?? {}),
      space_deduction: {
        ...(spaceDeduction ?? EMPTY_SPACE_DEDUCTION),
        ...patch,
      },
    });
  };

  // ── S6.3：params（4 元组）/ notes（行文本）/ constants（KV）──────────────
  const params = spec?.params ?? [];
  const patchParam = (index: number, col: 0 | 1 | 2 | 3, value: string) => {
    const next = params.map((row, i) => {
      if (i !== index) return row;
      const copy = [...row] as ParamRow;
      copy[col] = value;
      return copy;
    });
    commit({ ...(spec ?? {}), params: next });
  };
  const addParam = () =>
    commit({ ...(spec ?? {}), params: [...params, ["", "", "", ""]] });
  const removeParam = (index: number) =>
    commit({ ...(spec ?? {}), params: params.filter((_, i) => i !== index) });

  const notes = spec?.notes ?? [];
  const patchNote = (index: number, text: string) => {
    commit({
      ...(spec ?? {}),
      notes: notes.map((n, i) => (i === index ? text : n)),
    });
  };
  const addNote = () => commit({ ...(spec ?? {}), notes: [...notes, ""] });
  const removeNote = (index: number) =>
    commit({ ...(spec ?? {}), notes: notes.filter((_, i) => i !== index) });

  const constants = spec?.constants ?? {};
  const constantEntries = Object.entries(constants);
  const patchConstant = (key: string, value: string) => {
    commit({ ...(spec ?? {}), constants: { ...constants, [key]: value } });
  };
  const removeConstant = (key: string) => {
    const next = { ...constants };
    delete next[key];
    commit({ ...(spec ?? {}), constants: next });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1 rounded-lg border p-0.5">
        {(
          [
            { key: "specs", label: "数值参数 / 变体档位" },
            { key: "derived", label: "派生公式" },
            { key: "report", label: "列 / 校验 / 扣减" },
            { key: "meta", label: "参数 / 说明 / 常量" },
            { key: "json", label: "高级 JSON" },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => {
              setTab(t.key);
            }}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs transition-colors",
              tab === t.key
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {!parseOk && (
        <p className="text-xs text-destructive">
          当前 JSON 无法解析（语法错误），表单已锁定 —— 请在「高级
          JSON」里修正。
        </p>
      )}

      {/* JSON 语法错时锁定表单 —— 防止表单编辑把坏 JSON 覆盖成另一份数据 */}
      {parseOk && (
        <>
          {/* ── 数值参数 ── */}
          {tab === "specs" && parseOk && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-xs">
                  数值参数（丝径/网高/卷长… 连续值）
                </Label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={addNumeric}
                >
                  <Plus className="size-3" /> 加参数
                </Button>
              </div>
              {numerics.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  还没有数值参数 —— 连续量（丝径/网高/间距…）请加到这里，
                  枚举档位放「变体档位」。
                </p>
              )}
              {numerics.map((n, index) => (
                <div key={index} className="rounded-md border p-2.5 space-y-2">
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    <TextField
                      label="字段名 key"
                      value={n.key}
                      mono
                      onChange={(v) => patchNumeric(index, { key: v })}
                      placeholder="如 d / roll_dia_m"
                    />
                    <TextField
                      label="中文名"
                      value={n.label}
                      onChange={(v) => patchNumeric(index, { label: v })}
                    />
                    <TextField
                      label="英文名"
                      value={n.label_en}
                      onChange={(v) => patchNumeric(index, { label_en: v })}
                    />
                    <TextField
                      label="单位"
                      value={n.unit}
                      onChange={(v) => patchNumeric(index, { unit: v })}
                      placeholder="mm / m / kg"
                    />
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                    <NumberField
                      label="默认值"
                      value={n.default}
                      step="any"
                      onChange={(v) =>
                        patchNumeric(index, { default: v ?? undefined })
                      }
                    />
                    <NumberField
                      label="最小值"
                      value={n.min_value}
                      step="any"
                      onChange={(v) => patchNumeric(index, { min_value: v })}
                    />
                    <NumberField
                      label="最大值"
                      value={n.max_value}
                      step="any"
                      onChange={(v) => patchNumeric(index, { max_value: v })}
                    />
                    <NumberField
                      label="小数位"
                      value={n.decimals}
                      step="1"
                      onChange={(v) => patchNumeric(index, { decimals: v })}
                    />
                    <TextField
                      label="备注"
                      value={n.note}
                      onChange={(v) => patchNumeric(index, { note: v })}
                    />
                  </div>
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 text-xs text-muted-foreground"
                      onClick={() => removeNumeric(index)}
                    >
                      <Trash2 className="size-3" /> 删除
                    </Button>
                  </div>
                </div>
              ))}

              <div className="flex items-center justify-between pt-2">
                <Label className="text-xs">
                  变体档位（表面处理/工艺… 枚举取值）
                </Label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={addVariant}
                >
                  <Plus className="size-3" /> 加变体
                </Button>
              </div>
              {variants.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  还没有变体档位 —— 可枚举的属性（表面处理、材质…）请加到这里；
                  选项留空也可以（如「档位由客户在定价数据里自建」）。
                </p>
              )}
              {variants.map((v, index) => (
                <div key={index} className="rounded-md border p-2.5 space-y-2">
                  <div className="grid gap-2 sm:grid-cols-3">
                    <TextField
                      label="字段名 key"
                      value={v.name}
                      mono
                      onChange={(patch) => patchVariant(index, { name: patch })}
                      placeholder="如 coating / wave"
                    />
                    <TextField
                      label="中文名"
                      value={v.label}
                      onChange={(patch) =>
                        patchVariant(index, { label: patch })
                      }
                    />
                    <TextField
                      label="英文名"
                      value={v.label_en}
                      onChange={(patch) =>
                        patchVariant(index, { label_en: patch })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">
                      档位选项（可留空，后续在定价数据里加）
                    </Label>
                    {(v.options ?? []).map((opt, optIdx) => (
                      <div key={optIdx} className="flex items-center gap-1.5">
                        <Input
                          value={opt.name ?? ""}
                          onChange={(e) => {
                            const options = (v.options ?? []).map((o, i) =>
                              i === optIdx ? { ...o, name: e.target.value } : o,
                            );
                            patchVariant(index, { options });
                          }}
                          placeholder="档位名（如 普锌40g/㎡）"
                          className="h-7 text-xs"
                        />
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="size-7 shrink-0 text-muted-foreground"
                          onClick={() => {
                            const options = (v.options ?? []).filter(
                              (_, i) => i !== optIdx,
                            );
                            patchVariant(index, { options });
                          }}
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-6 text-xs"
                      onClick={() => {
                        const options = [...(v.options ?? []), { name: "" }];
                        patchVariant(index, { options });
                      }}
                    >
                      <Plus className="size-3" /> 加选项
                    </Button>
                  </div>
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 text-xs text-muted-foreground"
                      onClick={() => removeVariant(index)}
                    >
                      <Trash2 className="size-3" /> 删除
                    </Button>
                  </div>
                </div>
              ))}

              {productKey === "" && (
                <p className="text-[11px] text-muted-foreground">
                  新产品：`spec.key` 会在保存时自动填产品 Key。
                </p>
              )}
            </div>
          )}

          {/* ── 派生公式 ── */}
          {tab === "derived" && parseOk && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-xs">
                  派生公式（重量/体积/成本… 由数值参数折算）
                </Label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={addDerived}
                >
                  <Plus className="size-3" /> 加公式
                </Button>
              </div>
              {derived.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  还没有公式 —— 每条公式指明「怎么从数值参数算出一个指标」。
                  例如 `weight_kg = d**2 * 1.28 / mesh_cm * width_m * len_m`。
                </p>
              )}
              {derived.map((d, index) => (
                <div key={index} className="rounded-md border p-2.5 space-y-2">
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    <TextField
                      label="指标名 key"
                      value={d.name}
                      mono
                      onChange={(v) => patchDerived(index, { name: v })}
                      placeholder="如 weight_per_piece_kg"
                    />
                    <TextField
                      label="公式 expr"
                      value={d.expr}
                      mono
                      className="sm:col-span-2"
                      onChange={(v) => patchDerived(index, { expr: v })}
                      placeholder="如 d**2 * 1.28 / mesh_cm"
                    />
                    <TextField
                      label="单位"
                      value={d.unit}
                      onChange={(v) => patchDerived(index, { unit: v })}
                      placeholder="kg / m³ / ㎡"
                    />
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                    <TextField
                      label="中文名"
                      value={d.label}
                      onChange={(v) => patchDerived(index, { label: v })}
                    />
                    <TextField
                      label="英文名"
                      value={d.label_en}
                      onChange={(v) => patchDerived(index, { label_en: v })}
                    />
                    <NumberField
                      label="小数位"
                      value={d.decimals}
                      step="1"
                      onChange={(v) => patchDerived(index, { decimals: v })}
                    />
                    <label className="flex items-center gap-1.5 pt-5 text-xs">
                      <input
                        type="checkbox"
                        checked={!!d.integer}
                        onChange={(e) =>
                          patchDerived(index, { integer: e.target.checked })
                        }
                        className="size-3"
                      />
                      整数量
                    </label>
                    <TextField
                      label="备注（口径说明）"
                      value={d.note}
                      onChange={(v) => patchDerived(index, { note: v })}
                    />
                  </div>
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 text-xs text-muted-foreground"
                      onClick={() => removeDerived(index)}
                    >
                      <Trash2 className="size-3" /> 删除
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* S6.2: columns / invariants / space_deduction */}
      {tab === "report" && parseOk && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label className="text-xs">
              输出列（报表列：internal=True
              只进内部核算视图，对外展示不暴露成本利润）
            </Label>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={addColumn}
            >
              <Plus className="size-3" /> 加列
            </Button>
          </div>
          {columns.length === 0 && (
            <p className="text-xs text-muted-foreground">
              还没有输出列 —— 每条公式（derived）产出的指标若要出现在报表上，
              这里给它一列（key 用公式名）。
            </p>
          )}
          {columns.map((c, index) => (
            <div key={index} className="rounded-md border p-2.5 space-y-2">
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <TextField
                  label="列 key（= 公式名）"
                  value={c.key}
                  mono
                  onChange={(v) => patchColumn(index, { key: v })}
                  placeholder="如 price.cost_pretax"
                />
                <TextField
                  label="中文名"
                  value={c.label}
                  onChange={(v) => patchColumn(index, { label: v })}
                />
                <TextField
                  label="英文名"
                  value={c.label_en}
                  onChange={(v) => patchColumn(index, { label_en: v })}
                />
                <TextField
                  label="表头宽度（可选）"
                  value={c.width == null ? "" : String(c.width)}
                  onChange={(v) =>
                    patchColumn(index, { width: v === "" ? null : Number(v) })
                  }
                />
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <NumberField
                  label="小数位"
                  value={c.decimals}
                  step="1"
                  onChange={(v) => patchColumn(index, { decimals: v })}
                />
                <label className="flex items-center gap-1.5 pt-5 text-xs">
                  <input
                    type="checkbox"
                    checked={!!c.internal}
                    onChange={(e) =>
                      patchColumn(index, { internal: e.target.checked })
                    }
                    className="size-3"
                  />
                  仅内部可见（成本/利润列）
                </label>
                <div className="flex items-end justify-end">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 text-xs text-muted-foreground"
                    onClick={() => removeColumn(index)}
                  >
                    <Trash2 className="size-3" /> 删除
                  </Button>
                </div>
              </div>
            </div>
          ))}

          <div className="flex items-center justify-between pt-2">
            <Label className="text-xs">
              校验规则（不变量：表达式必须成立）
            </Label>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={addInvariant}
            >
              <Plus className="size-3" /> 加规则
            </Button>
          </div>
          {invariants.length === 0 && (
            <p className="text-xs text-muted-foreground">
              还没有校验规则 —— 想让「数量 × 单价 =
              行金额」这类恒等式出错时被拦住， 加到这里（表达式为 false
              时报警/阻断）。
            </p>
          )}
          {invariants.map((v, index) => (
            <div key={index} className="rounded-md border p-2.5 space-y-2">
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <TextField
                  label="规则名"
                  value={v.name}
                  mono
                  onChange={(patch) => patchInvariant(index, { name: patch })}
                  placeholder="如 qty_positive"
                />
                <TextField
                  label="表达式 expr"
                  value={v.expr}
                  mono
                  onChange={(patch) => patchInvariant(index, { expr: patch })}
                  placeholder="如 qty > 0"
                />
                <div>
                  <Label className="text-[11px] text-muted-foreground">
                    严重级
                  </Label>
                  <select
                    value={v.severity ?? "error"}
                    onChange={(e) =>
                      patchInvariant(index, {
                        severity: e.target.value as "error" | "warning",
                      })
                    }
                    className="h-7 w-full rounded border border-input bg-background px-2 text-xs"
                  >
                    <option value="error">error（阻断）</option>
                    <option value="warning">warning（仅提示）</option>
                  </select>
                </div>
              </div>
              <div className="flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 text-xs text-muted-foreground"
                  onClick={() => removeInvariant(index)}
                >
                  <Trash2 className="size-3" /> 删除
                </Button>
              </div>
            </div>
          ))}

          <div className="flex items-center justify-between pt-2">
            <Label className="text-xs">空间扣减（装柜体积口径）</Label>
          </div>
          <div className="rounded-md border p-2.5 space-y-2">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <Label className="text-[11px] text-muted-foreground">
                  模式
                </Label>
                <select
                  value={spaceDeduction?.mode ?? "ratio"}
                  onChange={(e) =>
                    patchSpaceDeduction({ mode: e.target.value })
                  }
                  className="h-7 w-full rounded border border-input bg-background px-2 text-xs"
                >
                  <option value="ratio">
                    比例（推荐：随数量缩放，不会负体积）
                  </option>
                  <option value="fixed">
                    固定值（小单会扣出负体积，慎用）
                  </option>
                  <option value="median">中位数</option>
                  <option value="mean">平均值</option>
                  <option value="formula">公式</option>
                </select>
              </div>
              <NumberField
                label={
                  (spaceDeduction?.mode ?? "ratio") === "ratio"
                    ? "扣减比例（0.04 = 4%）"
                    : "扣减值（m³）"
                }
                value={
                  typeof spaceDeduction?.value === "number"
                    ? spaceDeduction.value
                    : null
                }
                step="any"
                onChange={(v) => patchSpaceDeduction({ value: v })}
              />
              <TextField
                label="备注（口径说明）"
                value={spaceDeduction?.note}
                onChange={(v) => patchSpaceDeduction({ note: v })}
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              口径：实际占用体积 = 长方体累计 × (1 − 比例) −
              固定值。推荐只用比例 （如 0.04 = 装柜系数 0.96，来自智能表格 21
              行实测）。
            </p>
          </div>
        </div>
      )}

      {/* S6.3: params / notes / constants */}
      {tab === "meta" && parseOk && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label className="text-xs">
              参考参数（说明性参数表，不参与计算）
            </Label>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={addParam}
            >
              <Plus className="size-3" /> 加参数
            </Button>
          </div>
          {params.length === 0 && (
            <p className="text-xs text-muted-foreground">
              还没有参考参数 —— 「原料进货成本 / 客户每单填写 / 元/㎡」这类
              说明性的参数表放这里（只做展示与备忘）。
            </p>
          )}
          {params.map((row, index) => (
            <div
              key={index}
              className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5"
            >
              <TextField
                label="参数"
                value={row[0]}
                onChange={(v) => patchParam(index, 0, v)}
              />
              <TextField
                label="取值"
                value={row[1]}
                onChange={(v) => patchParam(index, 1, v)}
              />
              <TextField
                label="单位"
                value={row[2]}
                onChange={(v) => patchParam(index, 2, v)}
              />
              <TextField
                label="说明"
                value={row[3]}
                onChange={(v) => patchParam(index, 3, v)}
              />
              <div className="flex items-end">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 text-xs text-muted-foreground"
                  onClick={() => removeParam(index)}
                >
                  <Trash2 className="size-3" /> 删除
                </Button>
              </div>
            </div>
          ))}

          <div className="flex items-center justify-between pt-2">
            <Label className="text-xs">说明（notes：产品口径/计算说明）</Label>
            <Button type="button" size="sm" variant="outline" onClick={addNote}>
              <Plus className="size-3" /> 加一行
            </Button>
          </div>
          {notes.length === 0 && (
            <p className="text-xs text-muted-foreground">
              还没有说明 ——
              重量公式口径、装柜体积来源这类要给业务看的说明放这里。
            </p>
          )}
          {notes.map((n, index) => (
            <div key={index} className="flex items-center gap-1.5">
              <Input
                value={n}
                onChange={(e) => patchNote(index, e.target.value)}
                placeholder="一行说明"
                className="h-7 text-xs"
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-7 shrink-0 text-muted-foreground"
                onClick={() => removeNote(index)}
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
          ))}

          <div className="flex items-center justify-between pt-2">
            <Label className="text-xs">常量（公式里用到的常数）</Label>
          </div>
          {constantEntries.length === 0 && (
            <p className="text-xs text-muted-foreground">
              还没有常量 —— 公式里的 1.28（重量经验系数）这类常数放这里，
              改值时公式自动跟着变。
            </p>
          )}
          {constantEntries.map(([k, v]) => (
            <div key={k} className="flex items-center gap-1.5">
              <Input
                value={k}
                readOnly
                className="h-7 w-40 font-mono text-xs"
                title="常量名（改名请在高级 JSON 里改）"
              />
              <Input
                value={String(v)}
                onChange={(e) => patchConstant(k, e.target.value)}
                className="h-7 text-xs"
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-7 shrink-0 text-muted-foreground"
                onClick={() => removeConstant(k)}
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
          ))}
          <AddConstantRow
            onAdd={(key) => {
              commit({
                ...(spec ?? {}),
                constants: { ...constants, [key]: 0 },
              });
            }}
          />
        </div>
      )}

      {/* ── 高级 JSON（P14 保留的原 textarea，实时写 specJson）── */}
      {tab === "json" && (
        <div className="space-y-2">
          <p className="text-[11px] text-muted-foreground">
            直接改
            JSON（与表单双向同步，改完即生效）。语法错误时表单会锁定，修正后
            自动解锁。
          </p>
          <textarea
            value={specJson}
            onChange={(e) => onChange(e.target.value)}
            rows={12}
            className="w-full rounded border px-2 py-1 font-mono text-xs"
          />
          {!parseOk && (
            <p className="text-xs text-destructive">
              JSON 语法错误 —— 表单已锁定，修正后自动解锁。
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 新增常量行：常量名输入 + 加号。改名只允许在新增时定（避免 key 冲突静默覆盖）。
 */
function AddConstantRow({ onAdd }: { onAdd: (key: string) => void }) {
  const [draft, setDraft] = useState("");
  return (
    <div className="flex items-center gap-1.5 pt-1">
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="新常量名（如 wire_factor）"
        className="h-7 w-40 font-mono text-xs"
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7"
        onClick={() => {
          const key = draft.trim();
          if (!key) return;
          onAdd(key);
          setDraft("");
        }}
      >
        <Plus className="size-3" /> 加常量
      </Button>
    </div>
  );
}
