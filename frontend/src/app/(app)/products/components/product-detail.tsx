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
import { ErrorState } from "@/components/shared/error-state";
import { LoadingBlock } from "@/components/shared/loading-block";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRole } from "@/hooks/use-role";
import {
  copyCalculationRules,
  hasCalculationRules,
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
import {
  applyNameEnInfo,
  nameEnListFromInfo,
} from "@/lib/products/product-names";

import { AdvancedSpecSettings } from "./advanced-spec-settings";
import { BusinessSpecEditor } from "./business-spec-editor";
import { NameEnEditor } from "./name-en-editor";
import { ProductImagesSection } from "./product-images";

// 2026-10-23 产品表单收口（方案 OPTIMIZATION_PLAN_2026-10-23_PRODUCT_QUOTE_REDESIGN §3.1）：
//  · 材质/表面处理 → chips 多选项（「类似包装，添加多个可选项」）；表面处理并入原「可选档位」
//    的 coating 变体组（算价真源 spec.variants，只收口一个入口），材质存资料选项不算价。
//  · HS 编码只保留一处（backed by spec.hs_codes，报价/单证实际用它）。
//  · 包装（packing）改到独立「包装」区维护包装方式/是否默认/金额，这里不再放。
const PROFILE_FIELDS: [string, string, string][] = [
  ["usage", "用途", "如：围栏 / 养殖 / 边坡防护"],
  ["origin", "产地", "如：河北安平"],
];

/** 表面处理变体组识别：label 优先，name 别名兜底（勾花网 options 为空也认）。 */
const SURFACE_GROUP_ALIASES = ["surface", "coating", "surface_treatment"];
function findSurfaceGroup(spec: ProductSpec) {
  const groups = Array.isArray(spec.variants) ? spec.variants : [];
  return (
    groups.find((g) => g.label === "表面处理") ??
    groups.find((g) => SURFACE_GROUP_ALIASES.includes(g.name)) ??
    null
  );
}

function cloneSpec(spec: ProductSpec): ProductSpec {
  return JSON.parse(JSON.stringify(spec)) as ProductSpec;
}

/** chips 多选项编辑器（材质/表面处理通用）：可加/删多个候选项。 */
function OptionChips({
  values,
  onChange,
  placeholder,
  label,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  label: string;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v || values.includes(v)) return;
    onChange([...values, v]);
    setDraft("");
  };
  return (
    <div className="space-y-1">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2 py-1 text-xs"
          >
            {v}
            <button
              type="button"
              aria-label={"删除 " + v}
              className="text-muted-foreground hover:text-destructive"
              onClick={() => onChange(values.filter((x) => x !== v))}
            >
              ×
            </button>
          </span>
        ))}
        {values.length === 0 && (
          <span className="text-xs text-muted-foreground">未设置</span>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <Input
          value={draft}
          placeholder={placeholder}
          className="h-8 flex-1 text-xs"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 px-2 text-xs"
          onClick={add}
        >
          添加
        </Button>
      </div>
    </div>
  );
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
  // silent：这一块自己渲染错误态（ErrorState + 重试），不让每个失败请求各弹一条 toast
  const registrySpec = useRegistryProductSpec(
    product.tenant ? null : product.key,
    { silent: true },
  );
  const save = useSaveTenantProduct();
  const remove = useDeleteTenantProduct();
  const statuses = useProductQuoteStatus({ silent: true });
  const setQuoteEnabled = useSetProductQuoteEnabled();
  const profile = useProductProfile(product.key, { silent: true });
  const saveProfile = useSaveProductProfile(product.key);

  const baseSpec: ProductSpec | null =
    product.tenant?.spec ?? registrySpec.data ?? null;
  const [spec, setSpec] = useState<ProductSpec | null>(null);
  const [name, setName] = useState(product.name);
  // 英文名多值（主名在前）：第 1 个就是主英文名，报价/单证用它。
  // 系统产品（无 tenant_products 行）也能改 —— 落点在团队级 product_profiles.info。
  const [nameEnList, setNameEnList] = useState<string[]>(product.nameEnList);
  // 价格与利润（利润率/综合税费/成本口径）已从产品表单删除（在报价工作台配置），
  // 原 profitPct/taxPct/costBasis 三个 state 一并移除（保存时原样保留 spec 现值）。
  // info 承载资料字段 + material_options（string[]）⇒ 值类型放宽为 unknown。
  const [info, setInfo] = useState<Record<string, unknown>>({});
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
    const base: Record<string, unknown> = Object.fromEntries(
      PROFILE_FIELDS.map(([k]) => [k, raw[k] == null ? "" : String(raw[k])]),
    );
    // 材质 = 资料选项数组（D-1：不算价）；存 product_profiles.info.material_options。
    base.material_options = Array.isArray(raw.material_options)
      ? raw.material_options.map((x) => String(x))
      : [];
    setInfo(base);
  }, [profile.data]);

  // 英文名草稿：团队资料（product_profiles.info）优先；资料还没到/没配时用产品行上
  // 已经算好的「主名 + 别名」（/products 与 mergeWorkProducts 是同一口径，主名在前）。
  useEffect(() => {
    const fromProfile = nameEnListFromInfo(profile.data?.info);
    const fallback =
      product.nameEnList && product.nameEnList.length > 0
        ? product.nameEnList
        : product.nameEn
          ? [product.nameEn]
          : [];
    setNameEnList(fromProfile.length > 0 ? fromProfile : fallback);
  }, [product.key, product.nameEn, product.nameEnList, profile.data]);

  const materialOptions = Array.isArray(info.material_options)
    ? (info.material_options as unknown as string[])
    : [];
  const setMaterialOptions = (next: string[]) =>
    setInfo((prev) => ({ ...prev, material_options: next }));

  // 表面处理 = spec.variants 的 coating 变体组（算价真源）；未配置时为空。
  const surfaceGroup = spec ? findSurfaceGroup(spec) : null;
  const surfaceOptions = (surfaceGroup?.options ?? []).map((o) =>
    String(o.label ?? o.name ?? ""),
  );
  const setSurfaceOptions = (next: string[]) => {
    if (!spec) return;
    const groups = Array.isArray(spec.variants) ? [...spec.variants] : [];
    const name = surfaceGroup?.name ?? "coating";
    const label = surfaceGroup?.label ?? "表面处理";
    const options = next.map((v) => ({ name: v, label: v }));
    const idx = groups.findIndex((g) => g.name === name);
    if (idx >= 0) groups[idx] = { ...groups[idx], name, label, options };
    else groups.push({ name, label, options });
    setSpec({ ...spec, variants: groups });
  };

  const rulesReady = hasCalculationRules(spec);
  const isTenant = Boolean(product.tenant);
  const statusRow = (statuses.data ?? []).find(
    (r) => r.product_key === product.key,
  );
  const quoteEnabled = isTenant
    ? product.tenant?.is_active !== false
    : statusRow?.is_enabled !== false;

  const saving = save.isPending || saveProfile.isPending;

  /**
   * 团队资料（`GET /products/{key}/profile`）没取到。
   *
   * 为什么必须挡住保存：`info` 草稿是用 `profile.data` 初始化的，资料 502 时草稿是空的，
   * 这时点保存会 `PUT` 一份空资料回去 —— 把真实的用途/产地/材质**覆盖成空**。
   * 502 是可恢复的，覆盖是不可恢复的，宁可禁用保存并引导重试。
   */
  const profileUnavailable = profile.isError && !profile.data;

  /** 编辑器里的多英文名 → 送后端的规范形状（主名在前；空行丢掉）。 */
  const namesToSave = () => {
    const names = nameEnList.map((n) => n.trim()).filter(Boolean);
    return { names, primary: names[0] ?? "" };
  };

  /**
   * 唯一保存动作（2026-10-24 英文名修复）：
   *   1. 先 `PUT /products/{key}/profile` —— 团队资料 + **多英文名**。
   *      系统产品（鹿网/牛栏网/勾花网）没有 tenant_products 行，英文名只可能落在这里，
   *      以前只保存 profile 的 usage/origin/material_options ⇒ 英文名改完静默丢失。
   *   2. 有租户行时再 `PUT /tenant-products/{id}` —— 中文名 / 主英文名 / 规格；
   *      `product_name_en` 与 profile 的主名保持一致（既有读侧字段也跟上）。
   */
  const saveAll = async (activeOverride?: boolean) => {
    if (!spec) return;
    if (profileUnavailable) {
      toast.error(
        "团队资料还没取到（服务暂时不可用），请先点「重试」再保存，避免把已有资料覆盖成空",
      );
      return;
    }
    if (!name.trim()) {
      toast.error("产品名称不能为空");
      return;
    }
    const { names, primary } = namesToSave();
    // 2026-10-23：价格与利润（利润率/综合税费/成本口径）从产品表单删除——
    // 在报价工作台整单参数里配置（OPTIMIZATION_PLAN §3.1）。这里**原样保留**现有值
    // 作为引擎兜底默认，不再由用户在产品页改，也不再校验。
    const nextSpec: ProductSpec = {
      ...spec,
      key: product.key,
      name: name.trim(),
      name_en: primary,
    };
    try {
      await saveProfile.mutateAsync(applyNameEnInfo(info, names, primary));
      if (product.tenant?.id) {
        await save.mutateAsync({
          id: product.tenant.id,
          body: {
            product_key: product.key,
            product_name: name.trim(),
            product_name_en: primary || null,
            category_code: product.categoryCode || null,
            cost_field: product.tenant.cost_field || "raw_price",
            cost_basis: spec.cost_basis || "pretax",
            cost_unit: product.tenant.cost_unit || spec.cost_unit || null,
            profit_mode: "margin_on_price",
            profit_value: spec.profit_value ?? 0.06,
            misc_fee_rate: spec.misc_fee_rate ?? 0.03,
            spec: nextSpec,
            is_active: activeOverride ?? (quoteEnabled && rulesReady),
          },
        });
      }
      toast.success("已保存");
      onChanged();
    } catch {
      toast.error("保存失败：请检查产品名称与规格参数后重试");
    }
  };

  /**
   * 「按我们的规格自定义」：复制一份团队产品定义（同 key），**不再是改英文名的前提**。
   * 复制前先把英文名保存到团队资料，否则刚输入的别名会丢（复制动作会立刻刷新数据）。
   */
  const makeCustom = async () => {
    if (!spec) return;
    const { names, primary } = namesToSave();
    const nextSpec: ProductSpec = {
      ...cloneSpec(spec),
      key: product.key,
      name: name.trim(),
      name_en: primary,
    };
    try {
      await saveProfile.mutateAsync(applyNameEnInfo(info, names, primary));
      await save.mutateAsync({
        body: {
          product_key: product.key,
          product_name: name.trim(),
          product_name_en: primary || null,
          category_code: product.categoryCode || null,
          cost_field: "raw_price",
          cost_basis: spec.cost_basis || "pretax",
          cost_unit: spec.cost_unit || null,
          profit_mode: "margin_on_price",
          profit_value: spec.profit_value ?? 0.06,
          misc_fee_rate: spec.misc_fee_rate ?? 0.03,
          spec: nextSpec,
          is_active: rulesReady,
        },
      });
      toast.success("已复制为我们的自定义产品，可以修改了");
      onChanged();
    } catch {
      toast.error("复制失败，请重试");
    }
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
          onSuccess: () =>
            toast.success(!quoteEnabled ? "已在报价中启用" : "已停用"),
          onError: () => toast.error("操作失败，请重试"),
        },
      );
      return;
    }
    void saveAll(!quoteEnabled);
  };

  const otherProducts = useMemo(
    () => candidates.filter((c) => c.key !== product.key),
    [candidates, product.key],
  );

  if (!spec) {
    // 失败**不能**伪装成"正在读取…"（无限骨架）：给明确错误态 + 立即重试入口
    if (registrySpec.isError) {
      return (
        <ErrorState
          title="产品规格暂时加载不了"
          message="后台服务暂时不可用（内核正在启动），已自动重试。稍后点「重试」再取一次；如果一直失败，请联系平台管理员。"
          onRetry={() => void registrySpec.refetch()}
          retryLabel="重试"
        />
      );
    }
    return <LoadingBlock rows={3} />;
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
          {/* 「保存」对**所有产品**可用（系统产品保存的是团队资料：英文名/用途/产地…）。
              2026-10-24 前系统产品这里只有「按我们的规格自定义」，英文名根本没有保存入口。 */}
          <Button
            onClick={() => void saveAll()}
            disabled={saving || profileUnavailable}
            title={
              profileUnavailable
                ? "团队资料还没取到，保存已暂时禁用（先重试）"
                : undefined
            }
          >
            <Save className="mr-1 h-4 w-4" />
            {saving ? "保存中…" : "保存"}
          </Button>
          {isTenant ? (
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
          ) : (
            <Button
              variant="outline"
              onClick={() => void makeCustom()}
              disabled={saving}
            >
              按我们的规格自定义
            </Button>
          )}
        </div>
      </div>

      {!rulesReady && (
        <div className="rounded-xl border border-warning/40 bg-warning-muted px-4 py-3 text-sm text-warning-muted-foreground">
          <div className="flex items-start gap-2">
            <AlertTriangle
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
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
                <p className="text-xs">
                  请联系平台管理员补齐计算规则后再开启报价。
                </p>
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
              {isTenant
                ? "名称、英文名和资料按团队保存；改完点这里保存（英文名与规格会一并保存）。"
                : "平台内置产品：英文名和资料按团队保存，改完点这里保存；规格需要调整时再「按我们的规格自定义」。"}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={saving || profileUnavailable}
            title={
              profileUnavailable
                ? "团队资料还没取到，保存已暂时禁用（先重试）"
                : undefined
            }
            onClick={() => void saveAll()}
          >
            {saving ? "保存中…" : isTenant ? "保存产品信息" : "保存基本信息"}
          </Button>
        </div>
        {profileUnavailable ? (
          <div
            role="alert"
            className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"
          >
            <AlertTriangle
              className="size-4 shrink-0 text-destructive"
              aria-hidden
            />
            <span>
              团队资料暂时没取到（服务不可用），已自动重试。为避免把已有资料覆盖成空，
              保存已暂时禁用；点「重试」取回资料后再改。
            </span>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              onClick={() => void profile.refetch()}
            >
              重试
            </Button>
          </div>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="space-y-1">
            <span className="text-sm font-medium">产品名称</span>
            <Input
              value={name}
              disabled={!isTenant}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {/* 英文名多值：第 1 条是主英文名；系统产品同样可编辑（团队级资料，不是规格） */}
          <div className="space-y-1 sm:col-span-2 lg:col-span-2">
            <NameEnEditor
              names={nameEnList}
              onChange={setNameEnList}
              disabled={saving}
            />
          </div>
          {PROFILE_FIELDS.map(([key, label, placeholder]) => (
            <label key={key} className="space-y-1">
              <span className="text-sm font-medium">{label}</span>
              <Input
                value={String(info[key] ?? "")}
                placeholder={placeholder}
                onChange={(e) =>
                  setInfo((prev) => ({ ...prev, [key]: e.target.value }))
                }
              />
            </label>
          ))}
          {/* HS 编码：唯一入口（backed by spec.hs_codes，报价/单证取第一个） */}
          <label className="space-y-1">
            <span className="text-sm font-medium">HS 编码</span>
            <Input
              value={(spec?.hs_codes ?? []).join(", ")}
              placeholder="如：7314410000（多个用逗号分隔）"
              onChange={(e) => {
                if (!spec) return;
                setSpec({
                  ...spec,
                  hs_codes: e.target.value
                    .split(/[,，\s]+/)
                    .map((s) => s.trim())
                    .filter(Boolean),
                });
              }}
            />
            <span className="text-xs text-muted-foreground">
              一行可填多个，用逗号分隔；报价和单证优先取第一个。
            </span>
          </label>
        </div>

        {/* 材质 / 表面处理：多选项（「类似包装，添加多个可选项」）。
            材质=资料选项不算价；表面处理=spec.variants coating 变体组（算价真源）。 */}
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <OptionChips
            label="材质（可添加多个选项）"
            values={materialOptions}
            onChange={setMaterialOptions}
            placeholder="如：低碳钢丝，回车/点添加"
          />
          <OptionChips
            label="表面处理（可添加多个选项）"
            values={surfaceOptions}
            onChange={setSurfaceOptions}
            placeholder="如：热镀锌，回车/点添加"
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          材质为产品资料（报价时选一个，写进报价单与单证）；表面处理是报价档位，
          客户报价时从这些值里选，成本随档位走（在「定价数据」里给档位配成本）。
        </p>
      </section>

      {/* 规格与包装：2026-10-23 删「价格与利润」区（利润率/综合税费/成本口径
          改在报价工作台整单参数配置，见 OPTIMIZATION_PLAN §3.1）。 */}
      <section className="card-base p-5">
        <h3 className="text-sm font-semibold">规格与包装</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          规格参数是客户报价时要填的量；包装方式与金额在下方维护。
          利润率、综合税费、成本口径在报价工作台配置，不在这里。
        </p>
        {isTenant ? (
          <div className="mt-3">
            <Button size="sm" onClick={() => void saveAll()} disabled={saving}>
              <Save className="mr-1 h-3.5 w-3.5" />
              保存规格与包装
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
