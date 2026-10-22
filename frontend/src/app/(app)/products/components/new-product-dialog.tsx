"use client";

/**
 * 新建产品（保留空白新建，但要求选择计算方式）。
 *
 * - 从现有产品复制计算规则（默认）：新产品的公式/参数/列/校验都来自模板，
 *   名称、图片、档位、包装可以再改；
 * - 空白：先建产品，平台管理员稍后在高级设置里补计算规则；补齐前不能报价。
 *
 * 产品 key 由系统生成，界面不出现。
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  hasCalculationRules,
  makeProductKey,
  useRegistryProductSpec,
  useSaveTenantProduct,
  type ProductSpec,
  type WorkProduct,
} from "@/lib/products/tenant-products";

type Mode = "copy" | "blank";

export function NewProductDialog({
  open,
  onOpenChange,
  products,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  products: WorkProduct[];
  onCreated: (productKey: string) => void;
}) {
  const [name, setName] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [mode, setMode] = useState<Mode>("copy");
  const [sourceKey, setSourceKey] = useState(
    products.find((p) => !p.tenant)?.key ?? products[0]?.key ?? "",
  );
  // 弹窗可能在产品列表还没加载时挂载：sourceKey 初始为空时要回退到第一个产品，
  // 否则查询被禁用、点创建只会提示“正在读取模板规格”。
  const effectiveSourceKey = sourceKey || products[0]?.key || "";
  const sourceSpec = useRegistryProductSpec(
    open && mode === "copy" ? effectiveSourceKey : null,
  );
  const save = useSaveTenantProduct();

  const existingKeys = useMemo(
    () => products.map((p) => p.key),
    [products],
  );

  const submit = () => {
    if (!name.trim()) {
      toast.error("先给产品起个名字");
      return;
    }
    if (mode === "copy" && !sourceSpec.data) {
      toast.error("正在读取模板规格，请稍等");
      return;
    }
    const key = makeProductKey(nameEn, name, existingKeys);
    const source = products.find((p) => p.key === effectiveSourceKey);
    const base: ProductSpec =
      mode === "copy" && sourceSpec.data
        ? (JSON.parse(JSON.stringify(sourceSpec.data)) as ProductSpec)
        : { key, name: name.trim(), name_en: nameEn.trim(), axes: [], numeric_inputs: [], variants: [], derived: [] };
    const spec: ProductSpec = {
      ...base,
      key,
      name: name.trim(),
      name_en: nameEn.trim(),
    };
    save.mutate(
      {
        body: {
          product_key: key,
          product_name: name.trim(),
          product_name_en: nameEn.trim() || null,
          category_code: source?.categoryCode || null,
          cost_field: source?.tenant?.cost_field || "raw_price",
          cost_basis: source?.tenant?.cost_basis || "pretax",
          cost_unit: source?.tenant?.cost_unit || base.cost_unit || null,
          profit_mode: "margin_on_price",
          profit_value: source?.tenant?.profit_value ?? 0.06,
          misc_fee_rate: source?.tenant?.misc_fee_rate ?? 0.03,
          spec,
          is_active: mode === "copy" && hasCalculationRules(spec),
        },
      },
      {
        onSuccess: () => {
          toast.success(
            mode === "copy"
              ? "产品已创建（计算规则已带入）"
              : "产品已创建；补好计算规则后即可报价",
          );
          setName("");
          setNameEn("");
          onOpenChange(false);
          onCreated(key);
        },
        onError: () => toast.error("创建失败：名称不能重复，或规格格式不合法"),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>新建产品</DialogTitle>
          <DialogDescription>
            先填名称，再选计算方式。内部编号由系统自动生成，不需要填。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <label className="space-y-1">
            <span className="text-sm font-medium">产品名称</span>
            <Input
              value={name}
              placeholder="如：热镀锌勾花网"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium">英文名（可选）</span>
            <Input
              value={nameEn}
              placeholder="如：Hot-dip Galvanized Chain Link Fence"
              onChange={(e) => setNameEn(e.target.value)}
            />
          </label>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">计算方式</legend>
            <label className="flex items-start gap-2 rounded-lg border p-3 text-sm">
              <input
                type="radio"
                name="new-product-mode"
                checked={mode === "copy"}
                onChange={() => setMode("copy")}
              />
              <span>
                从现有产品复制计算规则（推荐）
                <span className="block text-xs text-muted-foreground">
                  重量、体积、成本怎么算直接沿用模板，改名称/图片/档位即可。
                </span>
              </span>
            </label>
            {mode === "copy" && (
              <select
                aria-label="选择计算规则模板"
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={effectiveSourceKey}
                onChange={(e) => setSourceKey(e.target.value)}
              >
                {products.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.name}
                    {p.isSystem ? "（平台内置）" : ""}
                  </option>
                ))}
              </select>
            )}
            <label className="flex items-start gap-2 rounded-lg border p-3 text-sm">
              <input
                type="radio"
                name="new-product-mode"
                checked={mode === "blank"}
                onChange={() => setMode("blank")}
              />
              <span>
                空白产品（稍后补计算规则）
                <span className="block text-xs text-muted-foreground">
                  先建档；补齐规则前不能报价，适合平台管理员先录基础资料。
                </span>
              </span>
            </label>
          </fieldset>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={save.isPending}
          >
            取消
          </Button>
          <Button type="button" onClick={submit} disabled={save.isPending}>
            {save.isPending ? "创建中…" : "创建产品"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
