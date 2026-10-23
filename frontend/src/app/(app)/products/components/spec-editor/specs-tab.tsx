"use client";

/**
 * 「数值参数 / 变体档位」页签（U-P1D2 从 product-spec-editor 拆出）。
 *
 * 数值参数 = 连续值（丝径/网高/间距…）；变体 = 枚举档位。
 * 两者都通过 model 写回 specJson（JSON 仍是唯一真源）。
 */
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { NumberField, TextField } from "./fields";
import type { SpecEditorModel } from "./use-spec-editor-model";

export function SpecsTab({
  model,
  productKey,
}: {
  model: SpecEditorModel;
  productKey?: string;
}) {
  const {
    numerics,
    patchNumeric,
    addNumeric,
    removeNumeric,
    variants,
    patchVariant,
    addVariant,
    removeVariant,
  } = model;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-xs">数值参数（丝径/网高/卷长… 连续值）</Label>
        <Button type="button" size="sm" variant="outline" onClick={addNumeric}>
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
              onChange={(v) => patchNumeric(index, { default: v ?? undefined })}
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
        <Label className="text-xs">变体档位（表面处理/工艺… 枚举取值）</Label>
        <Button type="button" size="sm" variant="outline" onClick={addVariant}>
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
              onChange={(patch) => patchVariant(index, { label: patch })}
            />
            <TextField
              label="英文名"
              value={v.label_en}
              onChange={(patch) => patchVariant(index, { label_en: patch })}
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
                  aria-label="删除该规格选项"
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
  );
}
