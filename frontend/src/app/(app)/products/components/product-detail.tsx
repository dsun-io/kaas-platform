"use client";

/**
 * 产品详情：图片 → 基本信息 → 规格与价格 → 高级设置（管理员折叠）。
 *
 * 关键口径：
 * - product_key 不展示；它是内部编号，保存时原样带上。
 * - 系统内置产品普通层只读；点“按我们的规格自定义”会复制一份团队覆盖（同 key）。
 * - 空白产品没有计算规则时显示“待配置规则”，并禁止开启报价。
 * - 业务层保存只 patch 业务字段；公式等底层字段原样保留。
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Save, Trash2 } from "lucide-react";

import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRole } from "@/hooks/use-role";
import {
  copyCalculationRules,
  hasCalculationRules,
  pctToRatio,
  ratioToPct,
  useDeleteTenantProduct,
  useProductQuoteStatus,
  useRegistryProductSpec,
  useSaveTenantProduct,
  useSetProductQuoteEnabled,
  type ProductSpec,
  type WorkProduct,
} from "@/lib/products/tenant-products";
import {
  useProductProfile,
  useSaveProductProfile,
} from "@/lib/products/use-products";

import { AdvancedSpecSettings } from "./advanced-spec-settings";
import { BusinessSpecEditor } from "./business-spec-editor";
import { ProductImagesSection } from "./product-images";

const PROFILE_FIELDS: [string, string, string][] = [
  ["material", "材质", "如：低碳钢丝 / 镀锌丝"],
  ["surface", "表面处理", "如：热镀锌 / 电镀锌 / PVC 浸塑"],
  ["usage", "用途", "如：围栏 / 养殖 / 边坡防护"],
  ["hs_code", "HS 编码（补充）", "如：7314.41.00"],
  ["packing", "包装", "如：编织袋 + 钢带 / 裸装"],
  ["origin", "产地", "如：河北安平"],
];

function cloneSpec(spec: ProductSpec): ProductSpec {
  return JSON.parse(JSON.stringify(spec)) as ProductSpec;
}

export function ProductDetail({
  product,
  candidates,
  onChanged,
  onDeleted,
}: {
  product: WorkProduct;
  candidates: WorkProduct[];
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const { isSystemAdmin } = useRole();
  const registrySpec = useRegistryProductSpec(
    product.tenant ? null : product.key,
  );
  const save = useSaveTenantProduct();
  const remove = useDeleteTenantProduct();
  const statuses = useProductQuoteStatus();
  const setQuoteEnabled = useSetProductQuoteEnabled();
  const profile = useProductProfile(product.key);
  const saveProfile = useSaveProductProfile(product.key);

  const baseSpec: ProductSpec | null = product.tenant?.spec ?? registrySpec.data ?? null;
  const [spec, setSpec] = useState<ProductSpec | null>(null);
  const [name, setName] = useState(product.name);
  const [nameEn, setNameEn] = useState(product.nameEn);
  const [profitPct, setProfitPct] = useState(
    () => ratioToPct(product.tenant?.profit_value ?? 0.06) || "6",
  );
  const [taxPct, setTaxPct] = useState(
    () => ratioToPct(product.tenant?.misc_fee_rate ?? 0.03) || "3",
  );
  const [costBasis, setCostBasis] = useState(
    product.tenant?.cost_basis || "pretax",
  );
  const [info, setInfo] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [copySource, setCopySource] = useState("");
  const [copyOpen, setCopyOpen] = useState(false);
  const copySpec = useRegistryProductSpec(copyOpen ? copySource : null);

  // 切换产品 / 规格数据到达时重置草稿（只在产品 key 或底稿真正变化时）
  useEffect(() => {
    if (baseSpec) setSpec(cloneSpec(baseSpec));
    else setSpec(null);
  }, [product.key, baseSpec]);

  useEffect(() => {
    const raw = (profile.data?.info ?? {}) as Record<string, unknown>;
    setInfo(
      Object.fromEntries(
        PROFILE_FIELDS.map(([k]) => [k, raw[k] == null ? "" : String(raw[k])]),
      ),
    );
  }, [profile.data]);

  const rulesReady = hasCalculationRules(spec);
  const isTenant = Boolean(product.tenant);
  const statusRow = (statuses.data ?? []).find(
    (r) => r.product_key === product.key,
  );
  const quoteEnabled = isTenant
    ? product.tenant?.is_active !== false
    : statusRow?.is_enabled !== false;

  const saveProduct = (activeOverride?: boolean) => {
    if (!spec) return;
    if (!name.trim()) return toast.error("产品名称不能为空");
    const profit = pctToRatio(profitPct);
    const tax = pctToRatio(taxPct);
    if (profit === null || profit < 0 || profit >= 1)
      return toast.error("售价利润率请填 0~99 之间的百分比");
    if (tax === null || tax < 0 || tax >= 1)
      return toast.error("综合税费请填 0~99 之间的百分比");
    const nextSpec: ProductSpec = {
      ...spec,
      key: product.key,
      name: name.trim(),
      name_en: nameEn.trim(),
      cost_basis: costBasis,
      profit_mode: "margin_on_price",
      profit_value: profit,
      misc_fee_rate: tax,
    };
    save.mutate(
      {
        id: product.tenant?.id,
        body: {
          product_key: product.key,
          product_name: name.trim(),
          product_name_en: nameEn.trim() || null,
          category_code: product.categoryCode || null,
          cost_field: product.tenant?.cost_field || "raw_price",
          cost_basis: costBasis,
          cost_unit: product.tenant?.cost_unit || spec.cost_unit || null,
          profit_mode: "margin_on_price",
          profit_value: profit,
          misc_fee_rate: tax,
          spec: nextSpec,
          is_active: activeOverride ?? (quoteEnabled && rulesReady),
        },
      },
      {
        onSuccess: () => {
          toast.success("产品已保存");
          onChanged();
        },
        onError: () =>
          toast.error("保存失败：请检查名称与规格参数后重试"),
      },
    );
  };

  const makeCustom = () => {
    if (!spec) return;
    const nextSpec: ProductSpec = {
      ...cloneSpec(spec),
      key: product.key,
      name: name.trim(),
      name_en: nameEn.trim(),
    };
    save.mutate(
      {
        body: {
          product_key: product.key,
          product_name: name.trim(),
          product_name_en: nameEn.trim() || null,
          category_code: product.categoryCode || null,
          cost_field: "raw_price",
          cost_basis: costBasis,
          cost_unit: spec.cost_unit || null,
          profit_mode: "margin_on_price",
          profit_value: pctToRatio(profitPct) ?? 0.06,
          misc_fee_rate: pctToRatio(taxPct) ?? 0.03,
          spec: nextSpec,
          is_active: rulesReady,
        },
      },
      {
        onSuccess: () => {
          toast.success("已复制为我们的自定义产品，可以修改了");
          onChanged();
        },
        onError: () => toast.error("复制失败，请重试"),
      },
    );
  };

  const applyCopiedRules = () => {
    if (!spec || !copySpec.data) return;
    setSpec(copyCalculationRules(spec, copySpec.data));
    toast.success("已带入计算规则；保存后生效");
    setCopyOpen(false);
  };

  const toggleQuote = () => {
    if (!rulesReady) {
      toast.error("还没有配置计算规则，暂不能开启报价");
      return;
    }
    if (!isTenant) {
      setQuoteEnabled.mutate(
        { productKey: product.key, enabled: !quoteEnabled },
        {
          onSuccess: () => toast.success(!quoteEnabled ? "已在报价中启用" : "已停用"),
          onError: () => toast.error("操作失败，请重试"),
        },
      );
      return;
    }
    saveProduct(!quoteEnabled);
  };

  const otherProducts = useMemo(
    () => candidates.filter((c) => c.key !== product.key),
    [candidates, product.key],
  );

  if (!spec) {
    return (
      <div className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
        {registrySpec.isError
          ? "产品规格读取失败，请刷新页面重试；如果一直失败，请联系平台管理员。"
          : "正在读取产品规格…"}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">{name || product.name}</h2>
          <p className="text-sm text-muted-foreground">
            {product.isSystem
              ? "平台内置产品；图片和基础信息按团队保存，规格可复制成我们自己的再改。"
              : "我们自己的产品；图片、基础信息、规格与价格都在这里维护。"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={quoteEnabled && rulesReady}
              disabled={!rulesReady}
              onChange={toggleQuote}
            />
            在报价中显示
          </label>
          {isTenant ? (
            <>
              <Button onClick={() => saveProduct()} disabled={save.isPending}>
                <Save className="mr-1 h-4 w-4" />
                {save.isPending ? "保存中…" : "保存"}
              </Button>
              <Button
                variant="outline"
                className="text-destructive"
                onClick={() => {
                  setDeleteError(null);
                  setConfirmDelete(true);
                }}
              >
                <Trash2 className="mr-1 h-4 w-4" />
                删除
              </Button>
            </>
          ) : (
            <Button onClick={makeCustom} disabled={save.isPending}>
              按我们的规格自定义
            </Button>
          )}
        </div>
      </div>

      {!rulesReady && (
        <div className="rounded-xl border border-warning/40 bg-warning-muted px-4 py-3 text-sm text-warning-muted-foreground">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div className="space-y-2">
              <p>
                <strong>待配置计算规则，暂不可报价。</strong>
                空白产品不会自动算重量/成本；可以现在带入一套规则，或请平台管理员补齐。
              </p>
              {isSystemAdmin ? (
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    aria-label="从哪个产品带入计算规则"
                    className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                    value={copySource}
                    onChange={(e) => setCopySource(e.target.value)}
                  >
                    <option value="">选一个现有产品</option>
                    {otherProducts.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!copySource}
                    onClick={() => setCopyOpen(true)}
                  >
                    从其他产品带入计算规则
                  </Button>
                  {copyOpen && copySpec.data && (
                    <Button size="sm" onClick={applyCopiedRules}>
                      确认带入
                    </Button>
                  )}
                </div>
              ) : (
                <p className="text-xs">请联系平台管理员补齐计算规则后再开启报价。</p>
              )}
            </div>
          </div>
        </div>
      )}

      <ProductImagesSection productKey={product.key} />

      <section className="card-base p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">基本信息</h3>
            <p className="text-xs text-muted-foreground">
              图片、名称和资料按团队保存；名称/英文名修改后点右上角「保存」生效。
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={saveProfile.isPending}
            onClick={() =>
              saveProfile.mutate(info, {
                onSuccess: () => toast.success("基本信息已保存"),
                onError: () => toast.error("保存失败"),
              })
            }
          >
            {saveProfile.isPending ? "保存中…" : "保存基本信息"}
          </Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="space-y-1">
            <span className="text-sm font-medium">产品名称</span>
            <Input
              value={name}
              disabled={!isTenant}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium">英文名</span>
            <Input
              value={nameEn}
              disabled={!isTenant}
              placeholder="报价/单证上的英文产品名"
              onChange={(e) => setNameEn(e.target.value)}
            />
          </label>
          {PROFILE_FIELDS.map(([key, label, placeholder]) => (
            <label key={key} className="space-y-1">
              <span className="text-sm font-medium">{label}</span>
              <Input
                value={info[key] ?? ""}
                placeholder={placeholder}
                onChange={(e) =>
                  setInfo((prev) => ({ ...prev, [key]: e.target.value }))
                }
              />
            </label>
          ))}
        </div>
      </section>

      <section className="card-base p-5">
        <h3 className="text-sm font-semibold">价格与利润</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          系统会按成本、利润率和综合税费自动算报价；不确定时保持默认即可。
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="space-y-1">
            <span className="text-sm font-medium">售价利润率（%）</span>
            <Input
              inputMode="decimal"
              value={profitPct}
              onChange={(e) => setProfitPct(e.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium">综合税费（%）</span>
            <Input
              inputMode="decimal"
              value={taxPct}
              onChange={(e) => setTaxPct(e.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium">成本口径</span>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={costBasis}
              onChange={(e) => setCostBasis(e.target.value)}
            >
              <option value="pretax">不含税</option>
              <option value="incl_tax">含税</option>
            </select>
          </label>
        </div>
        {isTenant ? (
          <div className="mt-3">
            <Button size="sm" onClick={() => saveProduct()} disabled={save.isPending}>
              <Save className="mr-1 h-3.5 w-3.5" />
              保存规格与价格
            </Button>
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">
            这是平台内置规格；需要调整时点右上角「按我们的规格自定义」。
          </p>
        )}

        <div className="mt-6">
          <BusinessSpecEditor spec={spec} onChange={setSpec} />
        </div>
      </section>

      {isSystemAdmin && (
        <AdvancedSpecSettings
          spec={spec}
          productKey={product.key}
          onChange={setSpec}
        />
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="删除这个自定义产品？"
        description="删除后报价下拉不再出现；历史报价和单证里的快照仍保留。"
        confirmLabel="删除"
        pending={remove.isPending}
        error={deleteError}
        onConfirm={() => {
          if (!product.tenant) return;
          remove.mutate(product.tenant.id, {
            onSuccess: () => {
              toast.success("已删除");
              setConfirmDelete(false);
              onDeleted();
            },
            onError: (err) =>
              setDeleteError(
                err instanceof Error ? err.message : "删除失败，请重试",
              ),
          });
        }}
      />
    </div>
  );
}

