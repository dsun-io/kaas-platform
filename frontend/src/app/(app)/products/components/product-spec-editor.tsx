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

type SpecShape = {
  key?: string;
  name?: string;
  numeric_inputs?: NumericInputItem[];
  variants?: VariantGroupItem[];
  derived?: DerivedItem[];
  [k: string]: unknown;
};

type EditorTab = "specs" | "derived" | "json";

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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1 rounded-lg border p-0.5">
        {(
          [
            { key: "specs", label: "数值参数 / 变体档位" },
            { key: "derived", label: "派生公式" },
            { key: "json", label: "高级 JSON" },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => {
              setTab(t.key);
              if (t.key === "json") setJsonDraft(specJson);
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
