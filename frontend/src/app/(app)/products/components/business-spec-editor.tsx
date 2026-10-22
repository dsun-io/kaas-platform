"use client";

/**
 * 产品规格 · 业务层编辑器（2026-10-22 傻瓜化）。
 *
 * 只暴露业务同事需要关心的内容：
 *  - 规格参数：客户报价时要填的参数（名称/单位/默认值/范围）；
 *  - 可选档位：如表面处理，客户从这些值里选；
 *  - 包装费：默认包装与金额；
 *  - HS 编码。
 *
 * 公式/列/校验/JSON 等底层结构**不在这里**，由平台管理员在折叠的高级设置里维护。
 * 这里只 patch 业务字段，未涉及的底层字段原样保留。
 */
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  NumericInputItem,
  PackagingItem,
  ProductSpec,
  VariantGroupItem,
} from "@/lib/products/tenant-products";

export function BusinessSpecEditor({
  spec,
  onChange,
}: {
  spec: ProductSpec;
  onChange: (next: ProductSpec) => void;
}) {
  const numericInputs = Array.isArray(spec.numeric_inputs)
    ? spec.numeric_inputs
    : [];
  const variants = Array.isArray(spec.variants) ? spec.variants : [];
  const packaging = Array.isArray(spec.packaging) ? spec.packaging : [];
  const hsCodes = Array.isArray(spec.hs_codes) ? spec.hs_codes : [];

  const patch = (next: Partial<ProductSpec>) => onChange({ ...spec, ...next });

  const updateNumeric = (index: number, next: Partial<NumericInputItem>) => {
    patch({
      numeric_inputs: numericInputs.map((n, i) =>
        i === index ? { ...n, ...next } : n,
      ),
    });
  };

  const updateVariant = (index: number, next: VariantGroupItem) => {
    patch({
      variants: variants.map((g, i) => (i === index ? next : g)),
    });
  };

  const addOption = (groupIndex: number, text: string) => {
    const group = variants[groupIndex];
    const value = text.trim();
    if (!group || !value) return;
    if (group.options.some((o) => (o.label ?? o.name) === value)) return;
    updateVariant(groupIndex, {
      ...group,
      options: [...group.options, { name: value, label: value }],
    });
  };

  const removeOption = (groupIndex: number, optionIndex: number) => {
    const group = variants[groupIndex];
    if (!group) return;
    updateVariant(groupIndex, {
      ...group,
      options: group.options.filter((_, i) => i !== optionIndex),
    });
  };

  const addPackaging = () => {
    patch({
      packaging: [
        ...packaging,
        {
          id: "pkg-" + Date.now(),
          name: "包装 " + (packaging.length + 1),
          method: "",
          is_default: packaging.length === 0,
          mode: "per_piece",
          amount: 0,
          ranges: [],
          created_at: new Date().toISOString(),
        },
      ],
    });
  };

  const updatePackaging = (index: number, next: Partial<PackagingItem>) => {
    patch({
      packaging: packaging.map((p, i) => (i === index ? { ...p, ...next } : p)),
    });
  };

  const removePackaging = (index: number) => {
    const next = packaging.filter((_, i) => i !== index);
    if (next.length > 0 && !next.some((p) => p.is_default)) {
      next[0] = { ...next[0], is_default: true };
    }
    patch({ packaging: next });
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold">规格参数（客户报价时填写）</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          例如丝径、网孔、宽度。名称和单位由产品模板决定，这里只调默认值与允许范围；
          客户填了范围外的值会被拦下。
        </p>
        {numericInputs.length === 0 ? (
          <p className="mt-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
            这个产品没有需要客户填写的规格参数（使用固定规格报价）。
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th scope="col" className="p-2">参数</th>
                  <th scope="col" className="p-2">单位</th>
                  <th scope="col" className="p-2">默认值</th>
                  <th scope="col" className="p-2">最小值</th>
                  <th scope="col" className="p-2">最大值</th>
                </tr>
              </thead>
              <tbody>
                {numericInputs.map((n, i) => {
                  const scale = Number(n.ui_scale ?? 1) || 1;
                  const unit = n.ui_unit || n.unit || "—";
                  const toUi = (v: unknown) =>
                    v === null || v === undefined || v === ""
                      ? ""
                      : String(Number((Number(v) * scale).toFixed(6)));
                  const fromUi = (text: string) => {
                    if (text.trim() === "") return null;
                    const num = Number(text);
                    if (!Number.isFinite(num)) return null;
                    return scale === 1 ? num : num / scale;
                  };
                  return (
                    <tr key={n.key} className="border-b last:border-0">
                      <td className="p-2 font-medium">{n.label || n.key}</td>
                      <td className="p-2 text-muted-foreground">{unit}</td>
                      <td className="p-2">
                        <Input
                          aria-label={(n.label || n.key) + " 默认值"}
                          inputMode="decimal"
                          value={toUi(n.default)}
                          onChange={(e) =>
                            updateNumeric(i, { default: fromUi(e.target.value) })
                          }
                          className="h-8 w-24 text-xs"
                        />
                      </td>
                      <td className="p-2">
                        <Input
                          aria-label={(n.label || n.key) + " 最小值"}
                          inputMode="decimal"
                          value={toUi(n.min_value)}
                          onChange={(e) =>
                            updateNumeric(i, { min_value: fromUi(e.target.value) })
                          }
                          className="h-8 w-24 text-xs"
                        />
                      </td>
                      <td className="p-2">
                        <Input
                          aria-label={(n.label || n.key) + " 最大值"}
                          inputMode="decimal"
                          value={toUi(n.max_value)}
                          onChange={(e) =>
                            updateNumeric(i, { max_value: fromUi(e.target.value) })
                          }
                          className="h-8 w-24 text-xs"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <h3 className="text-sm font-semibold">可选档位</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          客户报价时从这些值里选，例如表面处理：热镀锌 / 电镀锌 / PVC 浸塑。
        </p>
        <div className="mt-3 space-y-3">
          {variants.map((group, gi) => (
            <div key={group.name} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">
                  {group.label || group.name}
                </span>
                <span className="text-xs text-muted-foreground">
                  {group.options.length > 0
                    ? "客户选一个"
                    : "还没有可选值"}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {group.options.map((option, oi) => (
                  <span
                    key={option.name}
                    className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2 py-1 text-xs"
                  >
                    {option.label || option.name}
                    <button
                      type="button"
                      aria-label={"删除 " + (option.label || option.name)}
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => removeOption(gi, oi)}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <OptionAdder
                  groupLabel={group.label || group.name}
                  onAdd={(text) => addOption(gi, text)}
                />
              </div>
            </div>
          ))}
          {variants.length === 0 && (
            <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
              这个产品没有可选档位，报价时按固定规格计算。
            </p>
          )}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">包装费</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              默认包装在报价时自动选中；未设默认时用最早创建的一套。
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={addPackaging}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            添加包装
          </Button>
        </div>
        {packaging.length === 0 ? (
          <p className="mt-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
            还没有包装费（报价时按 0 计）。
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {packaging.map((p, i) => (
              <div
                key={String(p.id ?? i)}
                className="flex flex-wrap items-center gap-2 rounded-lg border p-2"
              >
                <Input
                  aria-label="包装名称"
                  value={String(p.name ?? "")}
                  placeholder="包装名称"
                  onChange={(e) => updatePackaging(i, { name: e.target.value })}
                  className="h-8 w-40 text-xs"
                />
                <Input
                  aria-label="包装方式"
                  value={String(p.method ?? "")}
                  placeholder="包装方式（如 编织袋+钢带）"
                  onChange={(e) => updatePackaging(i, { method: e.target.value })}
                  className="h-8 w-56 text-xs"
                />
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="radio"
                    name="default-packaging"
                    checked={Boolean(p.is_default)}
                    onChange={() =>
                      patch({
                        packaging: packaging.map((row, j) => ({
                          ...row,
                          is_default: j === i,
                        })),
                      })
                    }
                  />
                  默认
                </label>
                <label className="flex items-center gap-1 text-xs">
                  默认金额（元/卷）
                  <Input
                    aria-label="默认包装金额"
                    inputMode="decimal"
                    value={String(p.amount ?? 0)}
                    onChange={(e) =>
                      updatePackaging(i, { amount: Number(e.target.value) || 0 })
                    }
                    className="h-8 w-24 text-xs"
                  />
                </label>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto text-destructive"
                  onClick={() => removePackaging(i)}
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                  删除
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="text-sm font-semibold">HS 编码</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          一行可填多个，用逗号分隔；报价和单证优先取第一个。
        </p>
        <Input
          aria-label="HS 编码"
          value={hsCodes.join(", ")}
          placeholder="如：7314410000（多个用逗号分隔）"
          onChange={(e) =>
            patch({
              hs_codes: e.target.value
                .split(/[,，\s]+/)
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
          className="mt-2"
        />
      </div>
    </div>
  );
}

function OptionAdder({
  groupLabel,
  onAdd,
}: {
  groupLabel: string;
  onAdd: (text: string) => void;
}) {
  // 用受控 input + 回车/按钮添加，避免 window.prompt（移动端/测试都不友好）
  return (
    <span className="inline-flex items-center gap-1">
      <input
        aria-label={"给 " + groupLabel + " 添加可选值"}
        placeholder="加一个值"
        className="h-7 w-24 rounded-md border border-input bg-background px-2 text-xs"
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          const value = e.currentTarget.value;
          if (value.trim()) {
            onAdd(value);
            e.currentTarget.value = "";
          }
        }}
      />
      <button
        type="button"
        className="rounded-md border px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted"
        onClick={(e) => {
          const input = e.currentTarget
            .previousElementSibling as HTMLInputElement | null;
          if (input && input.value.trim()) {
            onAdd(input.value);
            input.value = "";
          }
        }}
      >
        添加
      </button>
    </span>
  );
}
