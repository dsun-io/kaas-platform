"use client";

/**
 * 「派生公式」页签（U-P1D2 从 product-spec-editor 拆出）。
 *
 * 每条公式 = 指标名 + expr（由数值参数折算）；右上角嵌 `ProductSpecTryout`
 * 用当前 spec 试算（仍走 /explain 的 spec_override，不新建接口）。
 */
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

import { ProductSpecTryout } from "../product-spec-tryout";
import { NumberField, TextField } from "./fields";
import type { SpecEditorModel } from "./use-spec-editor-model";

export function DerivedTab({
  model,
  productKey,
}: {
  model: SpecEditorModel;
  productKey?: string;
}) {
  const { spec, derived, patchDerived, addDerived, removeDerived } = model;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-xs">
          派生公式（重量/体积/成本… 由数值参数折算）
        </Label>
        <div className="flex items-center gap-2">
          <ProductSpecTryout productKey={productKey ?? ""} spec={spec} />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={addDerived}
          >
            <Plus className="size-3" /> 加公式
          </Button>
        </div>
      </div>
      {derived.length === 0 && (
        <p className="text-xs text-muted-foreground">
          还没有公式 —— 每条公式指明「怎么从数值参数算出一个指标」。 例如
          `weight_kg = d**2 * 1.28 / mesh_cm * width_m * len_m`。
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
  );
}
