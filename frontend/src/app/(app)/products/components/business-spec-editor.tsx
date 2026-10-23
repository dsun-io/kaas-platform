"use client";

import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";

/**
 * 产品规格 · 业务层编辑器（2026-10-22 傻瓜化；2026-10-23 收口）。
 *
 * 只暴露业务同事需要关心的内容：
 *  - 规格参数：客户报价时要填的参数（名称/单位/默认值/最小值/最大值）；
 *  - 包装：包装方式 / 是否默认 / 金额。
 *
 * 2026-10-23：「可选档位」（表面处理）与「HS 编码」已移入产品「基本信息」区
 * （OPTIMIZATION_PLAN_2026-10-23_PRODUCT_QUOTE_REDESIGN §3.1）；变体数据仍是 spec.variants。
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
  // 2026-10-23：表面处理档位与 HS 编码已移入产品「基本信息」（OptionChips/合一字段），
  // 本组件只剩规格参数（min/max）与包装；variants 数据仍是 spec.variants（算价真源）。
  const packaging = Array.isArray(spec.packaging) ? spec.packaging : [];

  const patch = (next: Partial<ProductSpec>) => onChange({ ...spec, ...next });

  const updateNumeric = (index: number, next: Partial<NumericInputItem>) => {
    patch({
      numeric_inputs: numericInputs.map((n, i) =>
        i === index ? { ...n, ...next } : n,
      ),
    });
  };

  const addPackaging = () => {
    patch({
      packaging: [
        ...packaging,
        {
          id: "pkg-" + Date.now(),
          // 2026-10-23：不再生成「包装 N」这种人造名（用户要求去掉名称字段）。
          // name 字段保留但由 method 回填（旧报价快照兼容：packaging_name 一直有值）。
          name: "",
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
      packaging: packaging.map((p, i) =>
        i === index
          ? {
              ...p,
              ...next,
              // 包装方式是唯一真名：改方式时同步回填 name（展示/旧快照兼容）。
              ...(next.method !== undefined ? { name: next.method } : {}),
            }
          : p,
      ),
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
            <Table className="w-full min-w-[640px] text-sm">
              <TableHeader>
                <TableRow className="border-b text-left text-xs text-muted-foreground">
                  <TableHead scope="col" className="p-2">
                    参数
                  </TableHead>
                  <TableHead scope="col" className="p-2">
                    单位
                  </TableHead>
                  <TableHead scope="col" className="p-2">
                    默认值
                  </TableHead>
                  <TableHead scope="col" className="p-2">
                    最小值
                  </TableHead>
                  <TableHead scope="col" className="p-2">
                    最大值
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
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
                    <TableRow key={n.key} className="border-b last:border-0">
                      <TableCell className="p-2 font-medium">
                        {n.label || n.key}
                      </TableCell>
                      <TableCell className="p-2 text-muted-foreground">
                        {unit}
                      </TableCell>
                      <TableCell className="p-2">
                        <Input
                          aria-label={(n.label || n.key) + " 默认值"}
                          inputMode="decimal"
                          value={toUi(n.default)}
                          onChange={(e) =>
                            updateNumeric(i, {
                              default: fromUi(e.target.value),
                            })
                          }
                          className="h-8 w-24 text-xs"
                        />
                      </TableCell>
                      <TableCell className="p-2">
                        <Input
                          aria-label={(n.label || n.key) + " 最小值"}
                          inputMode="decimal"
                          value={toUi(n.min_value)}
                          onChange={(e) =>
                            updateNumeric(i, {
                              min_value: fromUi(e.target.value),
                            })
                          }
                          className="h-8 w-24 text-xs"
                        />
                      </TableCell>
                      <TableCell className="p-2">
                        <Input
                          aria-label={(n.label || n.key) + " 最大值"}
                          inputMode="decimal"
                          value={toUi(n.max_value)}
                          onChange={(e) =>
                            updateNumeric(i, {
                              max_value: fromUi(e.target.value),
                            })
                          }
                          className="h-8 w-24 text-xs"
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* 2026-10-23：原「可选档位」区删除——表面处理档位已并入产品「基本信息」chips
          （OPTIMIZATION_PLAN §3.1）；变体数据（spec.variants）仍是算价真源，不变。 */}

      <div>
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">包装</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              每行 =
              一种包装方式（含是否默认与金额）。默认包装在报价时自动选中；
              未设默认时用最早创建的一套。
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={addPackaging}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            添加包装
          </Button>
        </div>
        {packaging.length === 0 ? (
          <p className="mt-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
            还没有包装（报价时按 0 计）。
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {packaging.map((p, i) => (
              <div
                key={String(p.id ?? i)}
                className="flex flex-wrap items-center gap-2 rounded-lg border p-2"
              >
                <Input
                  aria-label="包装方式"
                  value={String(p.method ?? "")}
                  placeholder="包装方式（如 编织袋+钢带）"
                  onChange={(e) =>
                    updatePackaging(i, { method: e.target.value })
                  }
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
                      updatePackaging(i, {
                        amount: Number(e.target.value) || 0,
                      })
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
    </div>
  );
}
