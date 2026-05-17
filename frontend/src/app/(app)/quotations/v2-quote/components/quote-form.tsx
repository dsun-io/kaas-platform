"use client";

import {
  useState,
  useEffect,
  useRef,
  forwardRef,
  useImperativeHandle,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Loader2, Plus, X } from "lucide-react";
import { useProductSpecs } from "../hooks/use-v2-quote";
import type {
  QuoteV2Request,
  ProductSpecsOptions,
  QuotableSpecItem,
} from "@contracts/quote";
import {
  ProductCategory,
  categoryLabel,
  CATEGORY_CODES,
  CATEGORY_LABEL,
} from "@contracts/categories";
import { REQUIRED_SPEC_FIELDS } from "@contracts/validation";
import { resolveProvincePinyin } from "@/lib/utils";

interface ProductLineItem {
  key: string;
  product_category: string;
  product_type: string;
  wire_diameter: string;
  height: string;
  mesh_width: string;
  mesh_spec: string;
  roll_length: string;
  quantity: number;
  weight_kg: number;
}

interface Props {
  onSubmit: (input: QuoteV2Request) => void;
  isLoading: boolean;
}

const CATEGORIES = [...CATEGORY_CODES]; // codes for API

/** 拼音匹配映射: code → 拼音 */
const CATEGORY_PINYIN: Record<
  string,
  { initial: string; full: string; label: string }
> = {
  niulanwang: { initial: "nlw", full: "niulanwang", label: "牛栏网" },
  gouhuawang: { initial: "ghw", full: "gouhuawang", label: "勾花网" },
  post: { initial: "lz", full: "lizhu", label: "立柱" },
  gabion: { initial: "slw", full: "shilongwang", label: "石笼网" },
};

function matchCategory(code: string, query: string): boolean {
  const q = query.toLowerCase().trim();
  if (!q) return true;
  const info = CATEGORY_PINYIN[code];
  if (!info) return code.includes(q);
  return (
    info.label.includes(q) ||
    code.includes(q) ||
    info.initial.includes(q) ||
    info.full.includes(q)
  );
}

/** 与后端 ProductSpec 字段对应的前端表单字段列表（用于 cascading 过滤）。 */
const SPEC_FIELDS: (keyof ProductLineItem)[] = [
  "product_type",
  "wire_diameter",
  "height",
  "mesh_width",
  "mesh_spec",
  "roll_length",
];

/**
 * 从 quotable_specs 计算指定字段在当前选择下的可用选项。
 * 核心规则：计算某字段 options 时忽略该字段自身的当前值，避免自过滤导致无法切换。
 */
function getFieldOptions(
  field: keyof ProductLineItem,
  selectedValues: ProductLineItem,
  quotableSpecs: QuotableSpecItem[],
): string[] {
  const values = new Set<string>();
  for (const spec of quotableSpecs) {
    const matches = SPEC_FIELDS.every((key) => {
      if (key === field) return true; // 忽略自身
      const selectedValue = selectedValues[key];
      if (!selectedValue) return true; // 未选 → 不参与过滤
      const specValue = (spec as Record<string, unknown>)[key];
      return specValue != null && String(specValue) === String(selectedValue);
    });
    if (matches) {
      const v = (spec as Record<string, unknown>)[field];
      if (v != null && v !== "") values.add(String(v));
    }
  }
  return [...values].sort();
}

function ProductLineCard({
  item,
  index,
  onUpdate,
  onRemove,
  canRemove,
}: {
  item: ProductLineItem;
  index: number;
  onUpdate: (key: string, field: string, value: string | number) => void;
  onRemove: (key: string) => void;
  canRemove: boolean;
}) {
  // 品类搜索 combobox 状态（显示 label，存储 code）
  const [catSearch, setCatSearch] = useState(
    categoryLabel(item.product_category) ?? "",
  );
  const [catOpen, setCatOpen] = useState(false);
  const [catFiltering, setCatFiltering] = useState(false);
  const catRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setCatSearch(categoryLabel(item.product_category) ?? "");
  }, [item.product_category]);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (catRef.current && !catRef.current.contains(e.target as Node)) {
        setCatOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const { data: specs, isLoading: specsLoading } = useProductSpecs(
    item.product_category,
    {
      product_type: item.product_type || undefined,
      wire_diameter: item.wire_diameter || undefined,
      height: item.height ? parseFloat(item.height) : undefined,
      mesh_width: item.mesh_width ? parseFloat(item.mesh_width) : undefined,
      mesh_spec: item.mesh_spec || undefined,
      roll_length: item.roll_length ? parseFloat(item.roll_length) : undefined,
    },
  );

  // 重量自动回显：规格匹配时回填 weight_kg
  useEffect(() => {
    if (specs?.weight_kg != null) {
      onUpdate(item.key, "weight_kg", specs.weight_kg);
    }
  }, [specs?.weight_kg]);

  // quotable cascading options（忽略各字段自身当前值，实现联动过滤但不自锁）
  const qs = specs?.quotable_specs ?? [];
  const useCascading = qs.length > 0;
  const productTypeOptions = useCascading
    ? getFieldOptions("product_type", item, qs)
    : (specs?.options.product_types ?? []);
  const wireDiameterOptions = useCascading
    ? getFieldOptions("wire_diameter", item, qs)
    : (specs?.options.wire_diameters ?? []);
  const heightOptions = useCascading
    ? getFieldOptions("height", item, qs)
    : (specs?.options.heights ?? []).map(String);
  const meshWidthOptions = useCascading
    ? getFieldOptions("mesh_width", item, qs)
    : (specs?.options.mesh_widths ?? []).map(String);
  const meshSpecOptions = useCascading
    ? getFieldOptions("mesh_spec", item, qs)
    : (specs?.options.mesh_specs ?? []);
  const rollLengthOptions = useCascading
    ? getFieldOptions("roll_length", item, qs)
    : (specs?.options.roll_lengths ?? []).map(String);

  return (
    <Card className="overflow-visible">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">产品 {index + 1}</CardTitle>
          {canRemove && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => onRemove(item.key)}
            >
              <X className="size-3" />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* 产品品类 — 可搜索 combobox，支持拼音首字母匹配 */}
          <div className="space-y-1.5 relative" ref={catRef}>
            <Label>产品品类</Label>
            <Input
              value={catSearch}
              onChange={(e) => {
                const v = e.target.value;
                setCatSearch(v);
                setCatFiltering(true);
                setCatOpen(true);
                // 匹配 label → code 即时更新
                const matchedCode = CATEGORIES.find(
                  (c) => CATEGORY_PINYIN[c]?.label === v || c === v,
                );
                if (matchedCode) {
                  onUpdate(item.key, "product_category", matchedCode);
                  onUpdate(item.key, "product_type", "");
                  onUpdate(item.key, "wire_diameter", "");
                  onUpdate(item.key, "height", "");
                  onUpdate(item.key, "mesh_width", "");
                  onUpdate(item.key, "mesh_spec", "");
                  onUpdate(item.key, "roll_length", "");
                }
              }}
              onBlur={() => {
                // 失焦时将可能输入的 label 转为 code
                const matchedCode = CATEGORIES.find(
                  (c) =>
                    CATEGORY_PINYIN[c]?.label === catSearch || c === catSearch,
                );
                if (matchedCode && item.product_category !== matchedCode) {
                  onUpdate(item.key, "product_category", matchedCode);
                  onUpdate(item.key, "product_type", "");
                  onUpdate(item.key, "wire_diameter", "");
                  onUpdate(item.key, "height", "");
                  onUpdate(item.key, "mesh_width", "");
                  onUpdate(item.key, "mesh_spec", "");
                  onUpdate(item.key, "roll_length", "");
                }
                if (!matchedCode && catSearch) {
                  setCatSearch(categoryLabel(item.product_category) ?? "");
                }
              }}
              onFocus={() => {
                setCatOpen(true);
                setCatFiltering(false);
              }}
              placeholder="搜索或选择品类（支持拼音）"
              className="h-8 text-xs"
            />
            {catOpen &&
              (() => {
                const filteredCats = CATEGORIES.filter(
                  (c) => !catFiltering || matchCategory(c, catSearch),
                );
                return (
                  <div className="absolute z-50 mt-1 left-0 min-w-full w-max max-w-[calc(100vw-2rem)] rounded-lg border border-input bg-popover p-1 shadow-md">
                    {filteredCats.length === 0 ? (
                      <div className="px-2 py-1 text-xs text-muted-foreground">
                        无匹配品类
                      </div>
                    ) : (
                      filteredCats.map((c) => (
                        <div
                          key={c}
                          className="relative flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-xs outline-hidden select-none hover:bg-accent hover:text-accent-foreground"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setCatSearch(CATEGORY_PINYIN[c]?.label ?? c);
                            setCatFiltering(false);
                            setCatOpen(false);
                            onUpdate(item.key, "product_category", c);
                            onUpdate(item.key, "product_type", "");
                            onUpdate(item.key, "wire_diameter", "");
                            onUpdate(item.key, "height", "");
                            onUpdate(item.key, "mesh_width", "");
                            onUpdate(item.key, "mesh_spec", "");
                            onUpdate(item.key, "roll_length", "");
                          }}
                        >
                          {CATEGORY_PINYIN[c]?.label ?? c}
                        </div>
                      ))
                    )}
                  </div>
                );
              })()}
          </div>
          {/* 数量 — always rendered */}
          <div className="space-y-1.5">
            <Label>数量</Label>
            <Input
              type="number"
              min="1"
              value={item.quantity}
              onChange={(e) =>
                onUpdate(item.key, "quantity", parseInt(e.target.value) || 1)
              }
              className="h-8 text-xs"
            />
          </div>

          {/* 动态规格字段 — this section may show loading / specs / unsupported */}
          {specsLoading ? (
            <div className="col-span-2 flex items-center gap-2 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              加载规格选项...
            </div>
          ) : specs ? (
            <div className="contents">
              {productTypeOptions.length > 0 && (
                <div className="space-y-1.5">
                  <Label>产品类型</Label>
                  <select
                    value={item.product_type}
                    onChange={(e) =>
                      onUpdate(item.key, "product_type", e.target.value)
                    }
                    className="h-8 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-xs ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    <option value="">请选择</option>
                    {productTypeOptions.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {wireDiameterOptions.length > 0 && (
                <div className="space-y-1.5">
                  <Label>丝径</Label>
                  <select
                    value={item.wire_diameter}
                    onChange={(e) =>
                      onUpdate(item.key, "wire_diameter", e.target.value)
                    }
                    className="h-8 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-xs ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    <option value="">请选择</option>
                    {wireDiameterOptions.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {heightOptions.length > 0 && (
                <div className="space-y-1.5">
                  <Label>高度 (m)</Label>
                  <select
                    value={item.height}
                    onChange={(e) =>
                      onUpdate(item.key, "height", e.target.value)
                    }
                    className="h-8 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-xs ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    <option value="">请选择</option>
                    {heightOptions.map((h) => (
                      <option key={h} value={String(h)}>
                        {h}m
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {meshWidthOptions.length > 0 && (
                <div className="space-y-1.5">
                  <Label>网孔宽度</Label>
                  <select
                    value={item.mesh_width}
                    onChange={(e) =>
                      onUpdate(item.key, "mesh_width", e.target.value)
                    }
                    className="h-8 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-xs ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    <option value="">请选择</option>
                    {meshWidthOptions.map((w) => (
                      <option key={w} value={String(w)}>
                        {w}cm
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {meshSpecOptions.length > 0 && (
                <div className="space-y-1.5">
                  <Label>网孔规格</Label>
                  <select
                    value={item.mesh_spec}
                    onChange={(e) =>
                      onUpdate(item.key, "mesh_spec", e.target.value)
                    }
                    className="h-8 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-xs ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    <option value="">请选择</option>
                    {meshSpecOptions.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {rollLengthOptions.length > 0 && (
                <div className="space-y-1.5">
                  <Label>卷长 (m)</Label>
                  <select
                    value={item.roll_length}
                    onChange={(e) =>
                      onUpdate(item.key, "roll_length", e.target.value)
                    }
                    className="h-8 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-xs ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    <option value="">请选择</option>
                    {rollLengthOptions.map((l) => (
                      <option key={l} value={String(l)}>
                        {l}m
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          ) : (
            <p className="col-span-2 py-2 text-xs text-muted-foreground">
              当前品类暂不支持自动报价，请人工确认。
            </p>
          )}

          {/* 重量 — 规格选择完整后显示，可编辑 */}
          {specs?.weight_kg != null && (
            <div className="space-y-1.5">
              <Label>重量 (kg)</Label>
              <Input
                type="number"
                step="0.1"
                min="0"
                value={item.weight_kg ?? ""}
                onChange={(e) =>
                  onUpdate(
                    item.key,
                    "weight_kg",
                    parseFloat(e.target.value) || 0,
                  )
                }
                placeholder={`约 ${specs.weight_kg} kg`}
                className="h-8 text-xs"
              />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export interface QuoteFormHandle {
  resetAll: () => void;
}

export const QuoteForm = forwardRef<QuoteFormHandle, Props>(function QuoteForm(
  { onSubmit, isLoading }: Props,
  ref,
) {
  const [items, setItems] = useState<ProductLineItem[]>([
    {
      key: "1",
      product_category: "",
      product_type: "",
      wire_diameter: "",
      height: "",
      mesh_width: "",
      mesh_spec: "",
      roll_length: "",
      quantity: 1,
      weight_kg: 0,
    },
  ]);
  const [province, setProvince] = useState("");
  const [needInvoice, setNeedInvoice] = useState(false);
  const [taxRate, setTaxRate] = useState(0.03);
  const [validationError, setValidationError] = useState("");

  // 主产品的可报价规格数据（用于 quotable 校验）
  const mainItem = items[0]!;
  const { data: mainSpecs } = useProductSpecs(mainItem.product_category, {
    product_type: mainItem.product_type || undefined,
    wire_diameter: mainItem.wire_diameter || undefined,
    height: mainItem.height ? parseFloat(mainItem.height) : undefined,
    mesh_width: mainItem.mesh_width
      ? parseFloat(mainItem.mesh_width)
      : undefined,
    mesh_spec: mainItem.mesh_spec || undefined,
    roll_length: mainItem.roll_length
      ? parseFloat(mainItem.roll_length)
      : undefined,
  });

  const addItem = () => {
    setItems([
      ...items,
      {
        key: `${Date.now()}`,
        product_category: "",
        product_type: "",
        wire_diameter: "",
        height: "",
        mesh_width: "",
        mesh_spec: "",
        roll_length: "",
        quantity: 1,
        weight_kg: 0,
      },
    ]);
  };

  const removeItem = (key: string) => {
    setItems(items.filter((i) => i.key !== key));
  };

  /** 清除因上游字段变更而不再可选的规格值（从最下游向上游逐级校验）。 */
  function normalizeSelection(
    item: ProductLineItem,
    quotableSpecs: QuotableSpecItem[],
  ): ProductLineItem {
    const downstreamFirst = [
      "roll_length",
      "mesh_spec",
      "mesh_width",
      "height",
      "wire_diameter",
      "product_type",
    ] as const;
    let result = { ...item };
    for (const f of downstreamFirst) {
      if (!result[f]) continue;
      const options = getFieldOptions(f, result, quotableSpecs);
      if (!options.some((opt) => String(opt) === String(result[f]))) {
        result = { ...result, [f]: "" };
      }
    }
    return result;
  }

  const updateItem = (key: string, field: string, value: string | number) => {
    setItems((prev) => {
      const updated = prev.map((i) =>
        i.key === key ? { ...i, [field]: value } : i,
      );
      if (!mainSpecs?.quotable_specs?.length) return updated;
      const target = updated.find((i) => i.key === key)!;
      const normalized = normalizeSelection(target, mainSpecs.quotable_specs);
      return updated.map((i) => (i.key === key ? normalized : i));
    });
  };

  /** 判断当前已选组合是否存在于 quotable_specs 可报价规格列表中（精确 tuple 匹配） */
  function isQuotableSelection(
    item: ProductLineItem,
    specsData: ProductSpecsOptions | undefined,
  ): boolean {
    if (!specsData || item.product_category !== specsData.product_category)
      return false;
    const qs = specsData.quotable_specs;
    if (!qs || qs.length === 0) return false;
    return qs.some((spec) =>
      SPEC_FIELDS.every((key) => {
        const itemValue = item[key];
        if (!itemValue) return false; // 未完填 → 不计为可报价
        const specValue = (spec as Record<string, unknown>)[key];
        return specValue != null && String(specValue) === String(itemValue);
      }),
    );
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError("");

    // 前端规格校验
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const cat = item.product_category;
      const requiredFields = cat ? REQUIRED_SPEC_FIELDS[cat] : undefined;
      const missing: string[] = [];
      if (!cat || !requiredFields) {
        missing.push("产品品类");
      } else {
        for (const rf of requiredFields) {
          if (!item[rf.field as keyof ProductLineItem]) {
            missing.push(rf.label);
          }
        }
      }
      if (missing.length > 0) {
        setValidationError(
          `产品 ${i + 1} 请选择完整规格参数（缺少：${missing.join("、")}）`,
        );
        return;
      }
    }

    // quotable 校验：确认当前组合存在于可报价规格列表中
    const mainLine = items[0]!;
    if (!isQuotableSelection(mainLine, mainSpecs)) {
      setValidationError("当前条件下暂无可报价规格，请调整参数");
      return;
    }

    const apiRequest: Record<string, unknown> = {
      product_category: mainLine.product_category,
      quantity: mainLine.quantity,
      ...(mainLine.product_type && { product_type: mainLine.product_type }),
      ...(mainLine.wire_diameter && { wire_diameter: mainLine.wire_diameter }),
      ...(mainLine.mesh_spec && { mesh_spec: mainLine.mesh_spec }),
      ...(mainLine.mesh_width && {
        mesh_width: parseFloat(mainLine.mesh_width),
      }),
      ...(mainLine.height && { height: parseFloat(mainLine.height) }),
      ...(mainLine.roll_length && {
        roll_length: parseFloat(mainLine.roll_length),
      }),
      ...(province && { province }),
      need_invoice: needInvoice,
      ...(needInvoice && { tax_rate: taxRate }),
    };

    // 其余产品行 → accessory 兼容字段（内部兼容，用户不可见）
    if (items.length > 1) {
      apiRequest.accessories = items.slice(1).map((item) => ({
        product_category: item.product_category,
        ...(item.product_type && { product_type: item.product_type }),
        ...(item.height && { height: parseFloat(item.height) }),
        quantity: item.quantity,
      }));
    }

    onSubmit(apiRequest as QuoteV2Request);
  };

  useImperativeHandle(ref, () => ({
    resetAll() {
      setItems([
        {
          key: "1",
          product_category: "",
          product_type: "",
          wire_diameter: "",
          height: "",
          mesh_width: "",
          mesh_spec: "",
          roll_length: "",
          quantity: 1,
          weight_kg: 0,
        },
      ]);
      setProvince("");
      setNeedInvoice(false);
      setTaxRate(0.03);
      setValidationError("");
    },
  }));

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* 产品行列表 */}
      <div className="space-y-3">
        {items.map((item, index) => (
          <ProductLineCard
            key={item.key}
            item={item}
            index={index}
            onUpdate={updateItem}
            onRemove={removeItem}
            canRemove={items.length > 1}
          />
        ))}

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full text-xs"
          onClick={addItem}
        >
          <Plus className="mr-1 size-3" />
          添加产品
        </Button>
      </div>

      {/* 校验错误 */}
      {validationError && (
        <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {validationError}
        </div>
      )}

      {/* 运费 & 发票 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">运费选项（可选）</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>省份</Label>
              <Input
                value={province}
                onChange={(e) => {
                  const raw = e.target.value;
                  // 拼音首字母 → 中文省份即时转换
                  const resolved = resolveProvincePinyin(raw);
                  setProvince(resolved ?? raw);
                }}
                placeholder="如：广东省（支持拼音首字母）"
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={needInvoice}
                    onChange={(e) => setNeedInvoice(e.target.checked)}
                    className="size-4 rounded border-input accent-primary"
                  />
                  <span className="text-xs text-muted-foreground">含税</span>
                </label>
              </div>
              {needInvoice && (
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    step="0.1"
                    min="0"
                    max="100"
                    value={+(taxRate * 100).toFixed(1)}
                    onChange={(e) =>
                      setTaxRate(parseFloat(e.target.value) / 100 || 0)
                    }
                    className="h-8 text-xs w-28"
                  />
                  <span className="text-xs text-muted-foreground">%</span>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Button
        type="submit"
        size="default"
        disabled={isLoading}
        className="w-full"
      >
        {isLoading && <Loader2 className="mr-2 size-4 animate-spin" />}
        {isLoading ? "报价计算中..." : "获取报价"}
      </Button>
    </form>
  );
});
