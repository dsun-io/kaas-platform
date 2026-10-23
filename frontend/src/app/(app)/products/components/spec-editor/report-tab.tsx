"use client";

/**
 * 「列 / 校验 / 扣减」页签（U-P1D2 从 product-spec-editor 拆出）。
 *
 * S6.2 三段：报表列（internal 列只进内部核算）、不变量校验、空间扣减口径。
 */
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

import { NumberField, TextField } from "./fields";
import type { SpecEditorModel } from "./use-spec-editor-model";

export function ReportTab({ model }: { model: SpecEditorModel }) {
  const {
    columns,
    patchColumn,
    addColumn,
    removeColumn,
    invariants,
    patchInvariant,
    addInvariant,
    removeInvariant,
    spaceDeduction,
    patchSpaceDeduction,
  } = model;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-xs">
          输出列（报表列：internal=True
          只进内部核算视图，对外展示不暴露成本利润）
        </Label>
        <Button type="button" size="sm" variant="outline" onClick={addColumn}>
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
        <Label className="text-xs">校验规则（不变量：表达式必须成立）</Label>
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
          还没有校验规则 —— 想让「数量 × 单价 = 行金额」这类恒等式出错时被拦住，
          加到这里（表达式为 false 时报警/阻断）。
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
            <Label className="text-[11px] text-muted-foreground">模式</Label>
            <select
              value={spaceDeduction?.mode ?? "ratio"}
              onChange={(e) => patchSpaceDeduction({ mode: e.target.value })}
              className="h-7 w-full rounded border border-input bg-background px-2 text-xs"
            >
              <option value="ratio">
                比例（推荐：随数量缩放，不会负体积）
              </option>
              <option value="fixed">固定值（小单会扣出负体积，慎用）</option>
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
          口径：实际占用体积 = 长方体累计 × (1 − 比例) − 固定值。推荐只用比例
          （如 0.04 = 装柜系数 0.96，来自智能表格 21 行实测）。
        </p>
      </div>
    </div>
  );
}
