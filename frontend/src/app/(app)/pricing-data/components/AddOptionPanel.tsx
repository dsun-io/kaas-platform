"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Plus, X } from "lucide-react";
import type { PricingMatrix, SavePricingCell } from "@contracts/export-quote";

interface Props {
  matrix: PricingMatrix | undefined;
  busy: boolean;
  onSave: (payload: SavePricingCell) => void;
}

/**
 * 新增档位：给某个定价键维度加一个**产品定义里还没有的取值**，并同时录成本。
 *
 * 为什么两件事必须一起做（这是这一版最重要的口径）：
 * 档位与成本在业务眼里是一件事 ——「丝径 3.0，成本 4.8 元/kg」。
 * 拆成两步（先去产品定义加档位、再回来录成本）中间必然出现「加了档位没成本」
 * 或「录了成本没档位」的半成品状态。这里一次提交，两处同时生效：
 *   · 成本进定价数据；
 *   · 档位由定价数据**反推**出来（`load_option_extensions`），
 *     报价页的规格下拉随之多出这一项，不需要再去改产品定义。
 *
 * 变体档位要「档位名 + 编码」两栏：名是给人看的（可改），编码是**查价键的一部分**
 * （一改就与已录的成本对不上）。把这条差别摆在界面上，比事后解释便宜。
 */
export function AddOptionPanel({ matrix, busy, onSave }: Props) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [amount, setAmount] = useState("");

  if (!matrix || matrix.dims.length === 0) return null;

  // 闭包里拿不到 TS 的收窄（这层引用会变），先固定一份本地引用
  const mx = matrix;

  const existing = (field: string) =>
    new Set(
      mx.dims
        .find((d) => d.field === field)
        ?.options.map((o) => String(o.value)) ?? [],
    );

  /** 填了但产品定义里没有 → 这是「新档位」，需要显示名 */
  const isNew = (field: string) => {
    const v = (values[field] ?? "").trim();
    return v !== "" && !existing(field).has(v);
  };

  const filled = mx.dims.every((d) => (values[d.field] ?? "").trim() !== "");
  const hasNew = mx.dims.some((d) => isNew(d.field));
  const amountOk = Number(amount) > 0;
  const canSave = filled && hasNew && amountOk && !busy;

  function reset() {
    setValues({});
    setLabels({});
    setAmount("");
  }

  function submit() {
    const payloadValues: Record<string, string> = {};
    const payloadLabels: Record<string, string> = {};
    for (const dim of mx.dims) {
      const v = (values[dim.field] ?? "").trim();
      payloadValues[dim.field] = v;
      if (isNew(dim.field)) {
        // 轴类维度（丝径）没有单独的显示名：值与显示名本来就是同一个
        payloadLabels[dim.field] = (labels[dim.field] ?? "").trim() || v;
      }
    }
    onSave({
      product_key: mx.product_key,
      values: payloadValues,
      labels: payloadLabels,
      amount: Number(amount),
      unit: mx.cost_unit ? mx.cost_unit.split("/").slice(-1)[0] || "kg" : "kg",
    });
    reset();
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-lg">新增档位</CardTitle>
          <Button
            size="sm"
            variant={open ? "ghost" : "outline"}
            className="gap-1"
            onClick={() => (open ? (setOpen(false), reset()) : setOpen(true))}
          >
            {open ? <X className="size-3" /> : <Plus className="size-3" />}
            {open ? "取消" : "新增档位"}
          </Button>
        </div>
      </CardHeader>
      {open && (
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            给维度加一个产品定义里还没有的取值，并**同时**录入它的成本。
            保存后报价页的规格下拉会自动多出这一项。
          </p>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {matrix.dims.map((dim) => {
              const variant = dim.field.endsWith("_code");
              const fresh = isNew(dim.field);
              const dup = (values[dim.field] ?? "").trim() !== "" && !fresh;
              return (
                <div key={dim.field} className="space-y-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">
                      {dim.label}
                      {variant ? " · 档位编码" : dim.unit ? `（${dim.unit}）` : ""}
                    </Label>
                    <Input
                      className="h-8 text-xs"
                      placeholder={
                        variant
                          ? "如：zinc_60"
                          : `如：${dim.options.map((o) => o.label).join(" / ")} 之外的新值`
                      }
                      value={values[dim.field] ?? ""}
                      onChange={(e) =>
                        setValues((p) => ({
                          ...p,
                          [dim.field]: e.target.value,
                        }))
                      }
                    />
                  </div>

                  {variant && (
                    <div className="space-y-1.5">
                      <Label className="text-xs">档位名（界面上显示）</Label>
                      <Input
                        className="h-8 text-xs"
                        placeholder="如：镀锌60g/㎡"
                        value={labels[dim.field] ?? ""}
                        onChange={(e) =>
                          setLabels((p) => ({
                            ...p,
                            [dim.field]: e.target.value,
                          }))
                        }
                      />
                    </div>
                  )}

                  <p className="text-[11px] text-muted-foreground">
                    {dup
                      ? "该取值已在表里，直接在表中填价即可"
                      : fresh
                        ? "新档位：保存后会出现在报价页的规格下拉里"
                        : `已有：${dim.options.map((o) => o.label).join(" / ")}`}
                  </p>
                </div>
              );
            })}

            <div className="space-y-1.5">
              <Label className="text-xs">
                成本（
                {matrix.cost_unit
                  ? matrix.cost_unit.replace(/^CNY\//, "元/")
                  : "元/kg"}
                ）
              </Label>
              <Input
                type="number"
                step="0.01"
                inputMode="decimal"
                className="h-8 text-xs"
                placeholder="如：4.80"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Button
              size="sm"
              className="gap-1"
              disabled={!canSave}
              onClick={submit}
            >
              {busy ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Plus className="size-3" />
              )}
              保存档位与成本
            </Button>
            {!hasNew && filled && (
              <span className="text-xs text-muted-foreground">
                至少要有一个维度填成新取值，否则请直接在下面的表里填价。
              </span>
            )}
          </div>
        </CardContent>
      )}
    </Card>
  );
}
